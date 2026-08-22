// Aardvark module 35 — unrelated product listing helper.
export function getProductName35(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel35(name: string): string {
  return `Product: ${name}`;
}
