import assert from "node:assert/strict";
import test from "node:test";
import { checkoutTotal } from "../src/pricing.js";

test("premium customers receive the documented twenty percent discount", () => {
  const total = checkoutTotal([{ price: 100 }], { tier: "premium" });
  assert.equal(total, 80);
});

test("standard customers pay the subtotal", () => {
  const total = checkoutTotal([{ price: 100 }], { tier: "standard" });
  assert.equal(total, 100);
});
