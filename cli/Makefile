BIN := hledit
DIST := dist
LOCAL_BIN ?= $(HOME)/.local/bin

.PHONY: build install fmt test vet check clean

build:
	mkdir -p $(DIST)
	go build -o $(DIST)/$(BIN) .

install: build
	mkdir -p $(LOCAL_BIN)
	ln -sf $(PWD)/$(DIST)/$(BIN) $(LOCAL_BIN)/$(BIN)
	@echo "Installed $(BIN) -> $(LOCAL_BIN)/$(BIN)"

fmt:
	gofmt -w *.go

test:
	go test ./...

vet:
	go vet ./...

check: fmt test vet
	go test -cover ./...

clean:
	rm -rf $(DIST)
