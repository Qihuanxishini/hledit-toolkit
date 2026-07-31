export type InclusiveInterval = { start: number; end: number };

export class IntervalSet {
	readonly #intervals: InclusiveInterval[];

	constructor(intervals: readonly InclusiveInterval[] = []) {
		this.#intervals = [];
		for (const interval of intervals) this.add(interval.start, interval.end);
	}

	add(start: number, end: number): void {
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
			throw new Error(`Invalid inclusive interval ${start}-${end}.`);
		}
		const merged: InclusiveInterval[] = [];
		let next = { start, end };
		let inserted = false;
		for (const current of this.#intervals) {
			if (current.end < next.start - 1) {
				merged.push(current);
				continue;
			}
			if (next.end < current.start - 1) {
				if (!inserted) {
					merged.push(next);
					inserted = true;
				}
				merged.push(current);
				continue;
			}
			next = { start: Math.min(next.start, current.start), end: Math.max(next.end, current.end) };
		}
		if (!inserted) merged.push(next);
		this.#intervals.splice(0, this.#intervals.length, ...merged);
	}

	covers(start: number, end: number): boolean {
		return this.#intervals.some((interval) => interval.start <= start && interval.end >= end);
	}

	contains(line: number): boolean {
		return this.covers(line, line);
	}

	toArray(): InclusiveInterval[] {
		return this.#intervals.map((interval) => ({ ...interval }));
	}

	clone(): IntervalSet {
		return new IntervalSet(this.#intervals);
	}
}
