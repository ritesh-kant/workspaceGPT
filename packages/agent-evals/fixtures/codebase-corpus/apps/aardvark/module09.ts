// Aardvark module 09 — unrelated product listing helper.
export function getProductName09(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel09(name: string): string {
  return `Product: ${name}`;
}
