// Aardvark module 33 — unrelated product listing helper.
export function getProductName33(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel33(name: string): string {
  return `Product: ${name}`;
}
