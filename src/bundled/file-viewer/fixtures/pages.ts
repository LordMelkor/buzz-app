// Adversarial HTML namespace recovery cases, shared with real-browser probes.
export const mutationPages = [
  '<img src="https://evil.example.org/pixel" onerror="bad()">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example.org">',
  "<script>bad()</script>",
  '<base href="https://evil.example.org/"><a href="foo">go</a>',
].map(
  (tail) => `<form><math><mtext></form><form><mglyph><style></math>${tail}`,
);
