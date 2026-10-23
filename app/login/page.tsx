import { ArrowRight, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { getChatGPTUser } from "../chatgpt-auth";

export const dynamic = "force-dynamic";

type LoginSearchParams = { error?: string } | Promise<{ error?: string }>;

const errors: Record<string, string> = {
  not_configured: "登录服务尚未配置，请联系管理员。",
  state_mismatch: "登录会话已过期，请重新登录。",
  token_failed: "登录验证失败，请重试。",
  profile_failed: "无法读取账号信息，请重试。",
  email_unverified: "该账号的邮箱未验证，无法登录。",
  oauth_failed: "登录已取消或失败，请重试。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: LoginSearchParams;
}) {
  const user = await getChatGPTUser();
  if (user) redirect("/");

  const params = await searchParams;
  const message = params?.error ? errors[params.error] ?? errors.oauth_failed : null;

  return (
    <main className="access-shell">
      <a className="brand" href="/" aria-label="NUMEMS 席位申请中心">
        <span className="brand-mark"><i /><i /><i /></span>
        <span>NUMEMS<small>WORKSPACE</small><small className="developer-credit">Developed by xcsong</small></span>
      </a>
      <section className="access-card">
        <span className="access-icon"><ShieldCheck size={30} /></span>
        <span className="eyebrow">TEAM ACCESS, SIMPLIFIED</span>
        <h1>登录席位申请中心</h1>
        <p>请使用员工白名单中的本人邮箱登录。管理员使用管理员邮箱登录后会自动进入管理面板。</p>
        {message && <div className="access-account"><small>登录提示</small><strong>{message}</strong></div>}
        <div className="access-actions" style={{ flexDirection: "column" }}>
          <a className="button primary" href="/api/auth/google/start">
            <span>使用 Google 登录</span><ArrowRight size={16} />
          </a>
        </div>
        <p className="access-note">
          请使用员工白名单中的 Gmail 邮箱登录。<br />
          Outlook / QQ 邮箱暂不支持登录。
        </p>
      </section>
      <p className="access-footer">NUMEMS · 团队席位申请中心</p>
    </main>
  );
}
