package main

import (
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed packaging/2do.desktop
var desktopEntry string

//go:embed web/icons/icon.svg
var iconSVG []byte

// userPaths are where `2do install` puts things: per user, no root needed.
func userPaths() (bin, desktop, icon string) {
	home, _ := os.UserHomeDir()
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(home, ".local/share")
	}
	return filepath.Join(home, ".local/bin/2do"),
		filepath.Join(data, "applications/2do.desktop"),
		filepath.Join(data, "icons/hicolor/scalable/apps/2do.svg")
}

// install copies the running binary to ~/.local/bin and adds a launcher
// entry and icon, so 2do shows up in the app menu.
func install() error {
	bin, desktop, icon := userPaths()

	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return err
	}
	if self != bin {
		if err := copyExecutable(self, bin); err != nil {
			return err
		}
	}

	entry := strings.Replace(desktopEntry, "Exec=2do", "Exec="+bin, 1)
	if err := writeFile(desktop, []byte(entry), 0o644); err != nil {
		return err
	}
	if err := writeFile(icon, iconSVG, 0o644); err != nil {
		return err
	}
	refreshMenus(filepath.Dir(desktop))

	fmt.Printf("Installed 2do %s.\n\n  program:  %s\n  launcher: %s\n\n", version, bin, desktop)
	fmt.Println("Open it from your app menu (search \"2do\"), or run `2do`.")
	if !onPath(filepath.Dir(bin)) {
		fmt.Printf("Note: %s isn't on your PATH, so `2do` won't work in a terminal until you add it.\n", filepath.Dir(bin))
	}
	return nil
}

// uninstall removes what install added. Tasks in ~/.local/share/2do are kept.
func uninstall() error {
	bin, desktop, icon := userPaths()
	for _, p := range []string{bin, desktop, icon} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	refreshMenus(filepath.Dir(desktop))

	fmt.Println("Uninstalled 2do. Your tasks are kept in", xdgDir("XDG_DATA_HOME", ".local/share"))
	return nil
}

// copyExecutable writes to a temp file and renames it into place, so that
// reinstalling over a running copy works.
func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".2do-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())

	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

func writeFile(path string, b []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, perm)
}

// refreshMenus asks the desktop to pick up the new launcher right away. Most
// desktops notice on their own, so a missing tool isn't an error.
func refreshMenus(dir string) {
	if p, err := exec.LookPath("update-desktop-database"); err == nil {
		_ = exec.Command(p, dir).Run()
	}
}

func onPath(dir string) bool {
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if p == dir {
			return true
		}
	}
	return false
}
