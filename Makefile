BIN := 2do
VERSION ?= 0.2.1
ARCHES := amd64 arm64
MAINTAINER ?= $(shell git config user.name) <$(shell git config user.email)>

LDFLAGS := -s -w -X main.version=$(VERSION)
GOBUILD := CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)"

.PHONY: build run install uninstall dist

# Static binary with the web app embedded; runs on any Linux distro.
build:
	$(GOBUILD) -o $(BIN) .

run: build
	./$(BIN)

# Installs for the current user (no root): binary, icon and launcher entry.
install: build
	./$(BIN) install

# Removes the installed program files, not your tasks in ~/.local/share/2do.
uninstall: build
	./$(BIN) uninstall

# Release files in dist/, for each architecture:
#   2do-linux-<arch>          self-installing binary for any distro
#   2do_<version>_<arch>.deb  package for Debian, Ubuntu, Mint, Pop!_OS, ...
# plus SHA256SUMS.
dist: $(foreach a,$(ARCHES),dist/$(BIN)-linux-$(a) dist/$(BIN)_$(VERSION)_$(a).deb)
	cd dist && sha256sum $(BIN)-linux-* $(BIN)_$(VERSION)_*.deb > SHA256SUMS

dist/$(BIN)-linux-%: FORCE
	GOARCH=$* $(GOBUILD) -o $@ .

dist/$(BIN)_$(VERSION)_%.deb: dist/$(BIN)-linux-%
	install -Dm755 $< build/deb-$*/usr/bin/$(BIN)
	install -Dm644 packaging/2do.desktop build/deb-$*/usr/share/applications/2do.desktop
	install -Dm644 web/icons/icon.svg build/deb-$*/usr/share/icons/hicolor/scalable/apps/2do.svg
	install -d build/deb-$*/DEBIAN
	sed -e 's/@VERSION@/$(VERSION)/' -e 's/@ARCH@/$*/' -e 's/@MAINTAINER@/$(MAINTAINER)/' \
		packaging/deb-control > build/deb-$*/DEBIAN/control
	dpkg-deb --root-owner-group -Zxz --build build/deb-$* $@

FORCE:
