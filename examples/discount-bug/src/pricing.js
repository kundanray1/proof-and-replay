export function applyPremiumDiscount(subtotal, customer) {
  if (customer.tier !== "premium") return subtotal;
  return subtotal * 0.95;
}

export function checkoutTotal(items, customer) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return applyPremiumDiscount(subtotal, customer);
}
