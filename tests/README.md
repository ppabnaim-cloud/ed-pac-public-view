# Layout and behaviour tests

The dashboard's core promise is that **no screen ever scrolls**, on any tab, at
any step, on a 10-inch tablet held portrait. That is a property the eye cannot
reliably check across 36 combinations, so it is asserted automatically.

```bash
npm install playwright          # the browser itself is pre-installed
node gen_payloads.js            # build fixtures from the register
node build_test_page.js         # inline the Apps Script includes into one file
node test_layout.js             # every tab × step × viewport
node test_overlays.js           # search, help, table view, language toggle
```

`test_layout.js` asserts, for each of 3 viewports × 4 tabs × every step:

- the page does not scroll in either axis;
- no panel, tile or step overflows its own box;
- nothing is positioned outside the viewport;
- every chart actually rendered an `<svg>`;
- the content area receives at least 55% of the viewport height — this catches
  layout bugs that pass every overflow check while leaving the charts squashed
  into a strip.

`gas_stub.js` provides just enough of the Apps Script services (Properties,
Cache, Utilities, Session) to run `Code.gs` under Node, so the server
aggregation and the forecast can be exercised against real register data
without deploying.

Both scripts exit non-zero on failure and write screenshots to `shots/`.
