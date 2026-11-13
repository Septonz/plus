default: build

all: test

test: build
	cargo test -p loan_escrow

build:
	stellar contract build --package loan_escrow
	@ls -l ../../target/wasm32v1-none/release/loan_escrow.wasm

fmt:
	cargo fmt -p loan_escrow

clean:
	cargo clean -p loan_escrow
