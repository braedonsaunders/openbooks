import type { ApiKeyAuth } from "../api-auth";

export interface OpenBooksMcpRequestContext {
  auth: ApiKeyAuth;
  request: Request;
  requestId: string;
}
