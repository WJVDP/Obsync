const baseUrl = "http://localhost:8080";

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

export async function pushAndPullFlow(token: string, vaultId: string, deviceId: string): Promise<void> {
  await request(`/v1/vaults/${vaultId}/sync/push`, token, {
    method: "POST",
    body: JSON.stringify({
      deviceId,
      cursor: 0,
      ops: [
        {
          idempotencyKey: crypto.randomUUID(),
          deviceId,
          path: "daily.md",
          opType: "md_update",
          logicalClock: 1,
          payload: { yUpdateBase64: "AQID" },
          createdAt: new Date().toISOString()
        }
      ]
    })
  });

  const pull = await request<{ watermark: number; ops: unknown[] }>(
    `/v1/vaults/${vaultId}/sync/pull?since=0&deviceId=${deviceId}`,
    token
  );

  console.log("Pulled operations", pull.watermark, pull.ops.length);
}
