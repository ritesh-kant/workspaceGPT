// Aardvark module 40 — unrelated product listing helper.
export function getProductName40(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel40(name: string): string {
  return `Product: ${name}`;
}
