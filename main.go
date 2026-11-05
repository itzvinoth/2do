// 2do is a desktop shell for the 2do web app. It embeds the static app,
// serves it on localhost, persists data to a JSON file and opens the UI in a
// Chromium-family browser's app mode (a standalone window).
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

//go:embed all:web
var webFS embed.FS

const maxBody = 10 << 20

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install", "uninstall":
			run := install
			if os.Args[1] == "uninstall" {
				run = uninstall
			}
			if err := run(); err != nil {
				log.Fatalf("%s failed: %v", os.Args[1], err)
			}
			return
		}
	}

	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "2do %s\n\nUsage:\n  2do [flags]     start the app\n  2do install     install for this user (app menu entry, no root)\n  2do uninstall   remove the installed app (your tasks are kept)\n\nFlags:\n", version)
		flag.PrintDefaults()
	}
	port := flag.Int("port", 47823, "localhost port to serve on")
	noWindow := flag.Bool("no-window", false, "only run the server, don't open a window")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	url := "http://" + addr + "/"

	dataDir := xdgDir("XDG_DATA_HOME", ".local/share")
	cfgDir := xdgDir("XDG_CONFIG_HOME", ".config")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatal(err)
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Another instance is probably running. Just open a window to it.
		if isRunning(url) {
			if !*noWindow {
				if cmd := openWindow(url, cfgDir); cmd != nil {
					_ = cmd.Wait()
				}
			}
			return
		}
		log.Fatalf("error listening on %s: %v", addr, err)
	}

	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	sub, _ := fs.Sub(webFS, "web")
	st := &store{path: filepath.Join(dataDir, "data.json")}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/data", st.handle)
	files := http.FileServerFS(sub)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always revalidate so that a new build's assets are picked up.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))

	srv := &http.Server{Handler: guard(addr, mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	log.Printf("serving on %s, data: %s", url, st.path)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	if *noWindow {
		<-sig
		return
	}

	// Quit when the app window closes. If no app-mode browser was found,
	// the URL is opened in the default browser and the server keeps running.
	done := make(chan struct{})
	if cmd := openWindow(url, cfgDir); cmd != nil {
		go func() { _ = cmd.Wait(); close(done) }()
	} else {
		log.Printf("no Chromium-based browser found; opened in the default browser. Ctrl+C to quit.")
	}

	select {
	case <-sig:
	case <-done:
	}
}

// guard rejects requests whose Host isn't this server (DNS rebinding) and
// cross-site writes (CSRF from other web pages to localhost).
func guard(addr string, next http.Handler) http.Handler {
	_, port, _ := net.SplitHostPort(addr)
	hosts := map[string]bool{addr: true, "localhost:" + port: true}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hosts[r.Host] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			// A custom header can't be set cross-origin without a CORS
			// preflight, which this server never approves.
			if r.Header.Get("X-2do") != "1" {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type store struct {
	path string
	mu   sync.Mutex
}

func (s *store) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	w.Header().Set("Cache-Control", "no-store")

	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(s.path)
		if errors.Is(err, os.ErrNotExist) {
			b = []byte("null")
		} else if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)

	case http.MethodPut:
		b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
			return
		}
		if !json.Valid(b) {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}

		// Write atomically so a crash never leaves a half-written file.
		tmp := s.path + ".tmp"
		if err := os.WriteFile(tmp, b, 0o600); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(tmp, s.path); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// openWindow launches the first Chromium-family browser found in app mode
// with a dedicated profile, so the process lives exactly as long as the
// window. Falls back to xdg-open and returns nil.
func openWindow(url, cfgDir string) *exec.Cmd {
	for _, b := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge", "vivaldi"} {
		bin, err := exec.LookPath(b)
		if err != nil {
			continue
		}
		cmd := exec.Command(bin,
			"--app="+url,
			"--user-data-dir="+filepath.Join(cfgDir, "browser"),
			"--class=2do",
			"--window-size=1100,760",
			"--no-first-run",
			"--no-default-browser-check",
		)
		if err := cmd.Start(); err == nil {
			return cmd
		}
	}

	_ = exec.Command("xdg-open", url).Start()
	return nil
}

func isRunning(url string) bool {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url + "manifest.webmanifest")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func xdgDir(env, fallback string) string {
	if d := os.Getenv(env); d != "" {
		return filepath.Join(d, "2do")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, fallback, "2do")
}
