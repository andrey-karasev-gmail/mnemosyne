// Same domain as examples/example.ts (a pricing box + a label box), but split across two
// files to exercise cross-file tracing: named imports/exports are traced end to end, so
// labelBox's `total` param traces back through the import binding into price-box.ts's own
// `total` bind node, not just "the module as a whole".
export function priceBox(price: number, qty: number) {
  const subtotal = price * qty;
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  return { total, tax };
}
