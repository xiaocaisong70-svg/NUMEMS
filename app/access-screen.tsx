import { ArrowRight, LogIn, ShieldCheck } from "lucide-react";
import type { PortalAccess } from "@/lib/portal-access";

export default function AccessScreen({ access, email }: { access: PortalAccess; email?: string }) {
  const denied = access === "not_authorized";
  const unavailable = access === "unavailable";
  return <main className="access-shell">
    <a className="brand" href="/" aria-label="NUMEMS 席位申请中心">
      <span className="brand-mark"><i /><i /><i /></span>
      <span>NUMEMS<small>WORKSPACE</small><small className="developer-credit">Developed by xcsong</small></span>
    </a>
    <section className="access-card">
      <span className="access-icon"><ShieldCheck size={30} /></span>
      <span className="eyebrow">TEAM ACCESS, SIMPLIFIED</span>
      <h1>{unavailable ? "暂时无法连接" : denied ? "此邮箱尚未开通访问" : "按需申请，随时回来"}</h1>
      <p>{unavailable
        ? "暂时无法读取门户状态，请稍后刷新重试。"
        : denied
          ? "请确认登录邮箱与管理员登记的员工邮箱一致。需要开通时，请联系管理员加入员工白名单。"
          : "使用员工白名单中的本人 ChatGPT 账号登录，提交申请、查看排队进度或延长使用时间。"}</p>
      {denied && email && <div className="access-account"><small>当前登录邮箱</small><strong>{email}</strong></div>}
      <div className="access-actions">
        {unavailable ? <a className="button primary" href="/">刷新重试<ArrowRight size={16} /></a>
          : denied ? <>
            <a className="button primary" href="/signout-with-chatgpt?return_to=/" target="_top">退出并更换账号<LogIn size={16} /></a>
            <a className="button secondary" href="/">重新检查权限</a>
          </> : <a className="button primary" href="/signin-with-chatgpt?return_to=/" target="_top">使用 ChatGPT 登录<ArrowRight size={16} /></a>}
      </div>
      {!unavailable && <p className="access-note">席位到期或释放后，员工授权保留，可再次登录申请。<br />申请记录仅向本人和管理员展示。</p>}
    </section>
    <p className="access-footer">NUMEMS · 团队席位申请中心</p>
  </main>;
}
