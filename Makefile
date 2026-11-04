BIN := 2do
PREFIX ?= $(HOME)/.local

.PHONY: build run install uninstall

# Static binary with the web app embedded; runs on any Linux distro.
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BIN) .

run: build
	./$(BIN)

# Installs for the current user (no root): binary, icon and launcher entry.
install: build
	install -Dm755 $(BIN) $(PREFIX)/bin/$(BIN)
	install -Dm644 web/icons/icon.svg $(PREFIX)/share/icons/hicolor/scalable/apps/2do.svg
	install -Dm644 packaging/2do.desktop $(PREFIX)/share/applications/2do.desktop
	sed -i "s|^Exec=.*|Exec=$(PREFIX)/bin/$(BIN)|" $(PREFIX)/share/applications/2do.desktop

# Removes only the installed program files, not your data in ~/.local/share/2do.
uninstall:
	rm -f $(PREFIX)/bin/$(BIN) $(PREFIX)/share/icons/hicolor/scalable/apps/2do.svg $(PREFIX)/share/applications/2do.desktop
