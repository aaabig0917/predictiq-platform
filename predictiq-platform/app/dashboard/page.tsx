
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export default async function Dashboard() {
  // Next.js 16：等待實際請求，避免 Date.now() 預先渲染錯誤
  await connection();

  const supabase = await createClient();

  // 驗證登入狀態
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // 取得會員身分
  const { data: profile } = await supabase
    .from('profiles')
    .select('username,role')
    .eq('id', user.id)
    .single();

  // 取得會員期限
  const { data: membership } = await supabase
    .from('memberships')
    .select(
      'suspended,trial_expires_at,subscription_expires_at'
    )
    .eq('user_id', user.id)
    .single();

  // 停權或資料不存在時，禁止進入
  if (!profile || !membership || membership.suspended) {
    redirect('/login');
  }

  // 現在已在實際請求階段，可安全取得目前時間
  const now = Date.now();

  // 優先使用正式會員期限，其次使用試用期限
  const expiry =
    membership.subscription_expires_at &&
    Date.parse(membership.subscription_expires_at) > now
      ? membership.subscription_expires_at
      : membership.trial_expires_at &&
          Date.parse(membership.trial_expires_at) > now
        ? membership.trial_expires_at
        : null;

  // 一般會員必須具有有效期限；管理員不受期限限制
  if (profile.role !== 'admin' && !expiry) {
    redirect('/login?expired=1');
  }

  return (
    <main className="min-h-screen bg-slate-950 p-8 text-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between">
        <h1 className="text-3xl font-bold">
          PredictIQ Dashboard
        </h1>

        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="rounded-lg bg-slate-800 px-4 py-2"
          >
            登出
          </button>
        </form>
      </header>

      <section className="mx-auto mt-10 max-w-5xl rounded-xl border border-slate-800 p-6">
        <p>歡迎，{profile.username}</p>

        <p className="mt-2 text-slate-400">
          身分：{profile.role === 'admin' ? '管理員' : '會員'}
        </p>

        <p className="mt-2 text-slate-400">
          {profile.role === 'admin'
            ? '管理員不受試用期限限制'
            : `有效期限：${expiry}`}
        </p>

        <p className="mt-6">
          即時比分、角球、紅黃牌與 AI 分析功能即將整合。
        </p>
      </section>
    </main>
  );
}
