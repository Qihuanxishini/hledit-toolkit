import { computeAnchorTag } from "./anchor-hash.ts";
import { nextProofId } from "./proof-id.ts";
import type { HleditEditDelta, HleditReadLine } from "./result.ts";

export const MAX_EVIDENCE_RECORDS_PER_FILE = 10_000;
export const MAX_EVIDENCE_BYTES_PER_FILE = 4 * 1024 * 1024;
export const MAX_EVIDENCE_RECORDS_PER_SESSION = 50_000;
export const MAX_EVIDENCE_BYTES_PER_SESSION = 16 * 1024 * 1024;

export type EvidenceLine = { anchor: string; text: string };
export type ProofEpoch = {
	revision: string;
	proofId: string;
	proofIds: Set<string>;
	totalLines?: number;
	lines: Map<number, EvidenceLine>;
};
export type HistoricalProof = { epoch: ProofEpoch; positions: Map<number, number> };
export type FileProofState = {
	current: ProofEpoch;
	history: HistoricalProof[];
	capacityEvicted?: true;
	usage: { records: number; bytes: number };
};

// [喵喵喵]: 每次提交建立一次前缀位移索引；历史记录只做 O(log edits) 查询，不追逐别名链。
function coordinateTransform(deltas: readonly HleditEditDelta[]): (line: number) => number | undefined {
	let sum = 0;
	const shifts = deltas.map((delta) => (sum += delta.delta));
	return (line) => {
		let low = 0, high = deltas.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (deltas[middle]!.oldStart <= line) low = middle + 1;
			else high = middle;
		}
		if (low === 0) return line;
		const delta = deltas[low - 1]!;
		return line <= delta.oldEnd ? undefined : line + shifts[low - 1]!;
	};
}

function usage(path: string, current: ProofEpoch, history: readonly HistoricalProof[]) {
	let records = 0, bytes = Buffer.byteLength(path, "utf8");
	const texts = new Set<EvidenceLine>();
	for (const epoch of [current, ...history.map((item) => item.epoch)]) {
		records += epoch.lines.size + epoch.proofIds.size;
		bytes += 64 + epoch.lines.size * 16;
		for (const id of epoch.proofIds) bytes += Buffer.byteLength(id, "utf8");
		for (const line of epoch.lines.values()) texts.add(line);
	}
	for (const item of history) {
		records += item.positions.size;
		bytes += item.positions.size * 16;
	}
	for (const line of texts) bytes += Buffer.byteLength(line.anchor, "utf8") + Buffer.byteLength(line.text, "utf8");
	return { records, bytes };
}

export class ProofState {
	private readonly files = new Map<string, FileProofState>();
	private readonly owners = new Map<string, string>();
	private records = 0;
	private bytes = 0;

	get(path: string): FileProofState | undefined { return this.files.get(path); }
	owner(id: string): string | undefined { return this.owners.get(id); }
	clear(): void { this.files.clear(); this.owners.clear(); this.records = this.bytes = 0; }
	forkFile(path: string): ProofState {
		const copy = new ProofState();
		const file = this.files.get(path);
		if (file) {
			copy.files.set(path, file);
			copy.records = file.usage.records;
			copy.bytes = file.usage.bytes;
			for (const epoch of [file.current, ...file.history.map((item) => item.epoch)]) {
				for (const id of epoch.proofIds) copy.owners.set(id, path);
			}
		}
		return copy;
	}
	invalidate(path: string): void {
		const old = this.files.get(path);
		if (!old) return;
		for (const epoch of [old.current, ...old.history.map((item) => item.epoch)]) {
			for (const id of epoch.proofIds) this.owners.delete(id);
		}
		this.records -= old.usage.records;
		this.bytes -= old.usage.bytes;
		this.files.delete(path);
	}
	touch(path: string): void {
		const state = this.files.get(path);
		if (state) { this.files.delete(path); this.files.set(path, state); }
	}

	private store(path: string, current: ProofEpoch, history: HistoricalProof[], fresh: Map<number, EvidenceLine>, evicted = false, priority?: ReadonlySet<number>): void {
		// [喵喵喵]: 受控简化 — 最多保留 32 个旧坐标代，并同时受字节/记录预算约束；
		// 边界：更早的 proof 明确过期；升级：真实连续编辑频繁命中历史淘汰 → 调整保留策略。
		if (history.length > 32) history = history.slice(-32);
		let size = usage(path, current, history);
		const over = () => size.records > MAX_EVIDENCE_RECORDS_PER_FILE || size.bytes > MAX_EVIDENCE_BYTES_PER_FILE;
		// [喵喵喵]: 当前发布窗口优先于历史兼容；淘汰整个历史代，不让旧 id 改指向新坐标。
		while (over() && history.length) { history.shift(); size = usage(path, current, history); }
		// [喵喵喵]: 恢复时优先保留整个待确认目标，不让无关缓存挤掉刚补齐的消费范围。
		if (over() && priority) {
			current = { ...current, lines: new Map([...current.lines].filter(([line]) => priority.has(line) || fresh.has(line))), proofIds: new Set([current.proofId]) };
			evicted = true;
			size = usage(path, current, history);
		}
		if (over()) {
			current = { ...current, lines: fresh, proofIds: new Set([current.proofId]) };
			evicted = true;
			size = usage(path, current, history);
		}
		this.invalidate(path);
		if (over()) return;
		const state: FileProofState = { current, history, usage: size, ...(evicted ? { capacityEvicted: true } : {}) };
		this.files.set(path, state);
		this.records += size.records;
		this.bytes += size.bytes;
		for (const epoch of [current, ...history.map((item) => item.epoch)]) {
			for (const id of epoch.proofIds) this.owners.set(id, path);
		}
		while (this.records > MAX_EVIDENCE_RECORDS_PER_SESSION || this.bytes > MAX_EVIDENCE_BYTES_PER_SESSION) {
			this.invalidate(this.files.keys().next().value!);
		}
	}

	read(path: string, revision: string, rows: readonly HleditReadLine[], id = nextProofId(), totalLines?: number, priority?: ReadonlySet<number>): void {
		const previous = this.files.get(path);
		const same = previous?.current.revision === revision;
		const owner = this.owners.get(id);
		if (owner && (owner !== path || !same || !previous.current.proofIds.has(id))) { this.invalidate(path); return; }
		const fresh = new Map(rows.filter((line) => !line.textTruncated).map((line) => [line.line, { anchor: line.anchor, text: line.text }]));
		const current: ProofEpoch = {
			revision, proofId: id,
			proofIds: new Set([...(same ? previous.current.proofIds : []), id]),
			lines: new Map([...(same ? previous.current.lines : []), ...fresh]),
			totalLines: totalLines ?? (same ? previous.current.totalLines : undefined),
		};
		this.store(path, current, same ? [...previous.history] : [], fresh, same && previous.capacityEvicted, priority);
	}

	commit(path: string, revision: string, rows: readonly HleditReadLine[], deltas: HleditEditDelta[] | undefined, id: string, baseId?: string): void {
		if (this.owners.has(id)) { this.invalidate(path); return; }
		const previous = this.files.get(path);
		const trusted = previous && previous.current.proofId === baseId && deltas;
		if (!trusted) { this.invalidate(path); this.read(path, revision, rows, id); return; }
		const transform = coordinateTransform(deltas);
		const lines = new Map<number, EvidenceLine>();
		const positions = new Map<number, number>();
		for (const [oldLine, info] of previous.current.lines) {
			const line = transform(oldLine);
			if (line === undefined || computeAnchorTag(oldLine, info.text) !== info.anchor) continue;
			positions.set(oldLine, line);
			lines.set(line, line === oldLine ? info : { text: info.text, anchor: computeAnchorTag(line, info.text) });
		}
		const history = previous.history.map((item) => ({
			epoch: item.epoch,
			positions: new Map([...item.positions].flatMap(([source, target]) => {
				const line = transform(target);
				return line === undefined ? [] : [[source, line] as const];
			})),
		}));
		history.push({ epoch: previous.current, positions });
		const fresh = new Map(rows.filter((line) => !line.textTruncated).map((line) => [line.line, { anchor: line.anchor, text: line.text }]));
		for (const [line, info] of fresh) lines.set(line, info);
		this.store(path, {
			revision, proofId: id, proofIds: new Set([id]), lines,
			totalLines: previous.current.totalLines === undefined ? undefined
				: previous.current.totalLines + deltas.reduce((sum, delta) => sum + delta.delta, 0),
		}, history, fresh, previous.capacityEvicted);
	}
}
