package main

import (
	"embed"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"
)

//go:embed all:web/dist
var distFS embed.FS

// newFrontendHandler serves the built frontend from assets with the two
// deployment consequences from SPEC §2.2 baked in:
//
//  1. `.wasm` is served with Content-Type: application/wasm (required for
//     WebAssembly.instantiateStreaming), and a precompressed `.wasm.gz` is
//     served with Content-Encoding: gzip when the client accepts it, so the
//     2.8 MiB raw module never crosses the wire uncompressed.
//  2. Unknown extension-less paths fall back to index.html (SPA routing).
func newFrontendHandler(assets fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}

		if f, err := openReadSeeker(assets, name); err == nil {
			defer f.Close()
			if strings.HasSuffix(name, ".wasm") {
				w.Header().Set("Content-Type", "application/wasm")
				if acceptsGzip(r) {
					if gz, gzErr := openReadSeeker(assets, name+".gz"); gzErr == nil {
						defer gz.Close()
						w.Header().Set("Content-Encoding", "gzip")
						w.Header().Set("Vary", "Accept-Encoding")
						http.ServeContent(w, r, name, zeroTime, gz)
						return
					}
				}
			}
			http.ServeContent(w, r, name, zeroTime, f)
			return
		}

		// SPA fallback for routes; missing assets get a real 404.
		if strings.Contains(name, ".") {
			http.NotFound(w, r)
			return
		}
		index, err := openReadSeeker(assets, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer index.Close()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "index.html", zeroTime, index)
	})
}

func openReadSeeker(assets fs.FS, name string) (io.ReadSeekCloser, error) {
	f, err := assets.Open(name)
	if err != nil {
		return nil, err
	}
	rs, ok := f.(io.ReadSeekCloser)
	if !ok {
		f.Close()
		return nil, fs.ErrInvalid
	}
	return rs, nil
}

var zeroTime time.Time

func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	sub, err := fs.Sub(distFS, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("cuttle-web listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, newFrontendHandler(sub)))
}
