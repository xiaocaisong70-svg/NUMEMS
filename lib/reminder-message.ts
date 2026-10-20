export function reminderMessage(notice: { id: string; title: string }, expiry: string, portalUrl: string) {
  const url = new URL(portalUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || !Number.isFinite(Date.parse(expiry)))
    throw new Error("请先配置本优化版的 HTTPS 门户根地址。");
  return {
    subject: `${notice.title} [NUMEMS:${notice.id}]`,
    text: `你的 ChatGPT Business 席位即将到期。\n截止时间（UTC）：${expiry}\n续期：${url.origin}/\n如已续期，请以网页当前截止时间为准。`,
  };
}
