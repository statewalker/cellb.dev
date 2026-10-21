// HTMLRewriter behaviours compared with celld: element/text/comment/document handlers,
// attribute edits, content insertion (text vs html), removal, async handlers, selectors.
const PAGE = `<!doctype html><html><head><title>Old</title></head><body>
<!-- note --><h1 class="t">Hello <b>world</b></h1>
<a href="/x" data-k="1">x</a><a href="/y">y</a>
<p id="gone">remove me</p><ul><li>1</li><li>2</li></ul>
</body></html>`;

async function asyncHandlers() {
  const rewriter = new HTMLRewriter().on("a", {
    async element(el) {
      await new Promise((r) => setTimeout(r, 5));
      el.setAttribute("href", "/async");
    },
  });
  return new Response(await rewriter.transform(new Response('<p><a href="/x">x</a></p>')).text());
}

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/async") return asyncHandlers();
    const seen = [];
    const rewriter = new HTMLRewriter()
      .on("title", {
        element(el) {
          el.setInnerContent("New & <improved>");
        },
      })
      .on("h1.t", {
        element(el) {
          seen.push(`h1:${el.tagName}:${el.getAttribute("class")}:${el.hasAttribute("id")}`);
          el.setAttribute("id", "main");
          el.prepend("<i>before</i>", { html: true });
          el.append(" [end]");
        },
        text(t) {
          if (t.text.trim()) seen.push(`text:${t.text}:${t.lastInTextNode}`);
        },
      })
      .on("a[data-k]", {
        element(el) {
          el.setAttribute("href", "/changed");
          el.removeAttribute("data-k");
        },
      })
      .on("#gone", { element: (el) => el.remove() })
      .on("li:nth-child(2)", { element: (el) => el.replace("<li>two</li>", { html: true }) })
      .on("*", {
        comments(c) {
          seen.push(`comment:${c.text}`);
          c.replace("<!-- replaced -->", { html: true });
        },
      })
      .onDocument({
        doctype(d) {
          seen.push(`doctype:${d.name}`);
        },
        end(end) {
          end.append("<!-- the end -->", { html: true });
        },
      });
    const out = await rewriter.transform(new Response(PAGE, { headers: { "content-type": "text/html" } })).text();
    return Response.json({ out, seen });
  },
};
