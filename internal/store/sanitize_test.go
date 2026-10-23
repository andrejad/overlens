package store

import (
	"strings"
	"testing"
)

func Test_REQ_API_030_allowed_fonts_and_sizes_survive(t *testing.T) {
	for _, f := range []string{"Georgia, serif", "ui-monospace, monospace", "Arial, sans-serif", "Verdana, sans-serif", `"Times New Roman", serif`} {
		for _, in := range []string{
			`<p><span style='font-family: ` + f + `'>x</span></p>`,
			`<p><span style="font-family: ` + strings.ReplaceAll(f, `"`, `&quot;`) + `">x</span></p>`,
		} {
			out := sanitizeDescription(in)
			if !strings.Contains(out, "<span style=") || !strings.Contains(out, "x</span>") {
				t.Errorf("font %q lost: in=%s out=%s", f, in, out)
			}
			t.Logf("%s", out)
		}
	}
	for _, sz := range []string{"12px", "14px", "16px", "18px", "20px", "24px"} {
		out := sanitizeDescription(`<span style="font-size: ` + sz + `">x</span>`)
		if !strings.Contains(out, sz) || !strings.Contains(out, "<span style=") {
			t.Errorf("size %s lost: %s", sz, out)
		}
	}
}

func Test_REQ_API_030_both_properties_in_one_style(t *testing.T) {
	out := sanitizeDescription(`<span style="font-family: Georgia, serif; font-size: 18px">x</span>`)
	t.Logf("%s", out)
	for _, w := range []string{"font-family", "Georgia, serif", "font-size", "18px"} {
		if !strings.Contains(out, w) {
			t.Errorf("missing %q in %s", w, out)
		}
	}
}

func Test_REQ_API_030_underline_and_strike_survive(t *testing.T) {
	if out := sanitizeDescription(`<p><u>a</u><s>b</s></p>`); out != `<p><u>a</u><s>b</s></p>` {
		t.Errorf("got %s", out)
	}
}

func Test_REQ_API_030_disallowed_styles_are_stripped(t *testing.T) {
	cases := map[string]string{
		`<span style="color: red">x</span>`:                                  "<span>x</span>",
		`<span style="font-size: 13px">x</span>`:                             "<span>x</span>",
		`<span style="font-size: 100px">x</span>`:                            "<span>x</span>",
		`<span style="font-family: Comic Sans MS">x</span>`:                  "<span>x</span>",
		`<span style="font-family: Georgia">x</span>`:                        "<span>x</span>",
		`<span style="font-family: Georgia, serif, evil">x</span>`:           "<span>x</span>",
		`<span class="evil" onclick="a()">x</span>`:                          "<span>x</span>",
		`<span style="background:url(javascript:a())">x</span>`:              "<span>x</span>",
		`<p style="font-size: 12px">x</p>`:                                   "<p>x</p>",
		`<p style="font-family: Georgia, serif">x</p>`:                       "<p>x</p>",
		`<u style="font-size: 12px" class="c">x</u>`:                         "<u>x</u>",
		`<span style="font-size: 12px"><script>alert(1)</script>x</span>`:    `<span style="font-size: 12px">x</span>`,
		`<span style="font-size: 12px" class="c" onmouseover="a()">x</span>`: `<span style="font-size: 12px">x</span>`,
	}
	for in, want := range cases {
		if got := sanitizeDescription(in); got != want {
			t.Errorf("in=%s\n got=%s\nwant=%s", in, got, want)
		}
	}
	// A disallowed property next to an allowed one: only the allowed one stays.
	out := sanitizeDescription(`<span style="font-size: 12px; color: red">x</span>`)
	if strings.Contains(out, "color") || !strings.Contains(out, "12px") {
		t.Errorf("got %s", out)
	}
}
