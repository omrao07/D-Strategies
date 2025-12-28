// utils/response.ts
// Helpers to send JSON responses (pure Node, no imports)

function send(
  res: any,
  status: number,
  data: any,
  headers: { [key: string]: string } = {}
) {
  const body = data === undefined ? "" : JSON.stringify(data);
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    ...headers,
  };
  res.writeHead(status, h);
  res.end(body);
}

export const ok = (res: any, data: any) => send(res, 200, data);
export const created = (res: any, data: any) => send(res, 201, data);
export const noContent = (res: any) => send(res, 204, "");
export const badRequest = (res: any, msg = "Bad Request") =>
  send(res, 400, { error: msg });
export const unauthorized = (res: any, msg = "Unauthorized") =>
  send(res, 401, { error: msg });
export const forbidden = (res: any, msg = "Forbidden") =>
  send(res, 403, { error: msg });
export const notFound = (res: any, msg = "Not Found") =>
  send(res, 404, { error: msg });
export const error = (res: any, msg = "Internal Error") =>
  send(res, 500, { error: msg });

export { send };