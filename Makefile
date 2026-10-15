UUID := pastry@kurodaze.net
BUILD := build
ZIP := $(UUID).shell-extension.zip

.PHONY: all build check pack install enable test test-store test-shell clean

all: pack

node_modules: package.json package-lock.json
	npm ci --ignore-scripts
	@touch node_modules

build: node_modules
	rm -rf $(BUILD)
	npx --no-install tsc -p .
	cp metadata.json stylesheet.css LICENSE $(BUILD)/
	cp -r icons schemas $(BUILD)/
	rm -f $(BUILD)/schemas/gschemas.compiled

check: node_modules
	npx --no-install tsc --noEmit -p .

# Plain zip so it builds anywhere, also in CI; installing compiles the schema
pack: build
	rm -f $(ZIP)
	cd $(BUILD) && python3 -m zipfile -c ../$(ZIP) *

install: pack
	gnome-extensions install --force $(ZIP)

enable:
	gnome-extensions enable $(UUID)

test: test-store test-shell

test-store: build
	tmp=$$(mktemp -d) && XDG_DATA_HOME=$$tmp gjs -m tests/store.js; \
		status=$$?; rm -rf "$$tmp"; exit $$status

# Needs GNOME 50 or later: starts a throwaway headless shell
test-shell: pack
	sh tests/run-headless.sh $(ZIP)

clean:
	rm -rf $(BUILD) $(ZIP)
