export class SalesError extends Error {
  constructor(
    message: string,
    public status = 422,
    public code = "sales_refused",
  ) {
    super(message);
    this.name = "SalesError";
  }
}
