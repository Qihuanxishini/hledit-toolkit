BIN := hledit$(if $(filter Windows_NT,$(OS)),.exe,)
LOCAL_BIN ?= $(HOME)/.local/bin

.PHONY: build install fmt test lint check clean bundle

build:
	cargo build --release --locked

install: build
	mkdir -p "$(LOCAL_BIN)"
	cp "target/release/$(BIN)" "$(LOCAL_BIN)/$(BIN)"

fmt:
	cargo fmt

test:
	cargo test --locked

lint:
	cargo clippy --all-targets --locked -- -D warnings

check:
	cargo fmt --check
	cargo clippy --all-targets --locked -- -D warnings
	cargo test --locked

bundle:
	pwsh -NoProfile -File build-bundle.ps1

clean:
	cargo clean
