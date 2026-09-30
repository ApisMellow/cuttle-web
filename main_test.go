package main

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestFrontendHandlerServesSPAAndWASM(t *testing.T) {
	assets := fstest.MapFS{
		"index.html":     {Data: []byte("<main>Cuttle</main>")},
		"assets/app.js":  {Data: []byte("console.log('cuttle')")},
		"cuttle.wasm":    {Data: []byte("raw-wasm")},
		"cuttle.wasm.gz": {Data: []byte("gzipped-wasm")},
		"wasm_exec.js":   {Data: []byte("globalThis.Go = class Go {}")},
	}
	handler := newFrontendHandler(assets)

	tests := []struct {
		name           string
		path           string
		acceptEncoding string
		wantStatus     int
		wantType       string
		wantEncoding   string
		wantBody       string
	}{
		{
			name: "wasm mime", path: "/cuttle.wasm", wantStatus: http.StatusOK,
			wantType: "application/wasm", wantBody: "raw-wasm",
		},
		{
			name: "precompressed wasm", path: "/cuttle.wasm", acceptEncoding: "gzip",
			wantStatus: http.StatusOK, wantType: "application/wasm", wantEncoding: "gzip", wantBody: "gzipped-wasm",
		},
		{
			name: "spa fallback", path: "/game/deep-link", wantStatus: http.StatusOK,
			wantType: "text/html; charset=utf-8", wantBody: "<main>Cuttle</main>",
		},
		{
			name: "missing asset", path: "/assets/missing.js", wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.acceptEncoding != "" {
				req.Header.Set("Accept-Encoding", tc.acceptEncoding)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			response := recorder.Result()
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, tc.wantStatus)
			}
			if tc.wantType != "" && response.Header.Get("Content-Type") != tc.wantType {
				t.Fatalf("Content-Type = %q, want %q", response.Header.Get("Content-Type"), tc.wantType)
			}
			if response.Header.Get("Content-Encoding") != tc.wantEncoding {
				t.Fatalf("Content-Encoding = %q, want %q", response.Header.Get("Content-Encoding"), tc.wantEncoding)
			}
			if tc.wantBody != "" && string(body) != tc.wantBody {
				t.Fatalf("body = %q, want %q", body, tc.wantBody)
			}
		})
	}
}

var _ fs.FS = fstest.MapFS{}
