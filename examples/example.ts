// Two black boxes, chained: a numeric pricing box and a string-formatting box.
// TAX_RATE is read from process.env (the runner sets it before this module is
// evaluated) to exercise env-var capture; GREETING is a module-level const to
// exercise plain-constant capture.

const TAX_RATE = Number(process.env.TAX_RATE);
const GREETING = "Hello";

function priceBox(price: number, qty: number) {
  const subtotal = price * qty;
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;
  const isPremium = total > 50;
  return { total, tax, isPremium };
}

function labelBox(first: string, last: string, total: number) {
  const trimmedFirst = first.trim();
  const trimmedLast = last.trim();
  const fullName = trimmedFirst + " " + trimmedLast;
  const summary = GREETING + ", " + fullName + " - your total is " + total;
  return { fullName, summary };
}

const priceResult = priceBox(19.99, 3);
const chainedTotal = priceResult.total;
const labelResult = labelBox("  Ada ", "Lovelace  ", chainedTotal);

console.log(priceResult, labelResult);
