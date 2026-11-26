TARGET ?= $(shell rustc --print host-tuple)
TARGET_DIR ?= target
BIN := hledit$(if $(findstring windows,$(TARGET)),.exe,)
LOCAL_BIN ?= $(HOME)/.local/bin

.PHONY: build install fmt test lint check clean bundle

build:
	cargo build --release --locked --target "$(TARGET)" --target-dir "$(TARGET_DIR)"

install: build
	mkdir -p "$(LOCAL_BIN)"
	cp "$(TARGET_DIR)/$(TARGET)/release/$(BIN)" "$(LOCAL_BIN)/$(BIN)"

fmt:
	cargo fmt

test:
	cargo test --locked --target "$(TARGET)" --target-dir "$(TARGET_DIR)"

lint:
	cargo clippy --all-targets --locked --target "$(TARGET)" --target-dir "$(TARGET_DIR)" -- -D warnings

check:
	cargo fmt --check
	cargo clippy --all-targets --locked --target "$(TARGET)" --target-dir "$(TARGET_DIR)" -- -D warnings
	cargo test --locked --target "$(TARGET)" --target-dir "$(TARGET_DIR)"

bundle:
	pwsh -NoProfile -File build-bundle.ps1

clean:
	cargo clean --target-dir "$(TARGET_DIR)"
