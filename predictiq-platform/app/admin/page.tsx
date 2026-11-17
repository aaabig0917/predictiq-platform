
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

type MemberProfile = {
  id: string;
  username: string;
  line_name: string | null;
  external_member_id: string | null;
  role: string;
  created_at: string;
};

type Membership = {
  user_id: string;
  trial_used: boolean;
  trial_started_at: string | null;
  trial_expires_at: string | null;
  subscription_expires_at: string | null;
  suspended: boolean;
};

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error('缺少 Supabase 伺服器環境變數');
  }

  return createAdminClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// 每次執行管理操作，都重新確認目前登入者的身分
async function requireAdmin() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const { data: profile, error: profileError } =
    await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

  if (profileError || profile?.role !== 'admin') {
    redirect('/dashboard');
  }

  const admin = getAdminClient();

  // 以伺服器端資料再次確認管理員未被停權
  const { data: membership, error: membershipError } =
    await admin
      .from('memberships')
      .select('suspended')
      .eq('user_id', user.id)
      .single();

  if (membershipError || !membership || membership.suspended) {
    redirect('/dashboard');
  }

  return { admin, adminId: user.id };
}

function goToAdmin(message: string): never {
  redirect('/admin?message=' + encodeURIComponent(message));
}

function getString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

// 建立會員
async function createMember(formData: FormData) {
  'use server';

  const { admin } = await requireAdmin();

  const username = getString(formData, 'username');
  const email = getString(formData, 'email').toLowerCase();
  const password = String(formData.get('password') ?? '');
  const lineName = getString(formData, 'line_name');
  const externalMemberId = getString(
    formData,
    'external_member_id'
  );

  if (!/^[a-z0-9_]{4,32}$/.test(username)) {
    goToAdmin('帳號必須為 4～32 位小寫英文、數字或底線');
  }

  if (!email.includes('@') || email.length > 254) {
    goToAdmin('請輸入有效的 Email');
  }

  if (password.length < 12 || password.length > 128) {
    goToAdmin('密碼長度必須為 12～128 個字元');
  }

  if (!lineName || lineName.length > 100) {
    goToAdmin('請填寫 LINE 名稱，最多 100 個字元');
  }

  if (externalMemberId.length > 100) {
    goToAdmin('外部會員編號不可超過 100 個字元');
  }

  const { data: existing, error: lookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();

  if (lookupError) {
    goToAdmin('檢查會員帳號失敗');
  }

  if (existing) {
    goToAdmin('此會員帳號已存在');
  }

  // 使用 Supabase Admin API 建立登入帳號
  const { data: created, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

  if (authError || !created.user) {
    goToAdmin(
      '建立登入帳號失敗：' +
        (authError?.message ?? '未知錯誤')
    );
  }

  const userId = created.user.id;

  // 建立會員基本資料
  const { error: profileError } = await admin
    .from('profiles')
    .insert({
      id: userId,
      username,
      line_name: lineName,
      external_member_id: externalMemberId || null,
      role: 'member',
    });

  if (profileError) {
    await admin.auth.admin.deleteUser(userId);
    goToAdmin('建立會員資料失敗：' + profileError.message);
  }

  // 新會員尚未開始試用，首次成功登入才啟動
  const { error: membershipError } = await admin
    .from('memberships')
    .insert({
      user_id: userId,
      trial_used: false,
      trial_started_at: null,
      trial_expires_at: null,
      subscription_expires_at: null,
      suspended: false,
    });

  if (membershipError) {
    await admin.from('profiles').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);

    goToAdmin(
      '建立會員期限資料失敗：' + membershipError.message
    );
  }

  revalidatePath('/admin');
  goToAdmin('會員 ' + username + ' 建立成功');
}

// 延長正式會員期限
async function extendMembership(formData: FormData) {
  'use server';

  const { admin, adminId } = await requireAdmin();
  const userId = getString(formData, 'user_id');

  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    goToAdmin('會員 ID 格式錯誤');
  }

  if (userId === adminId) {
    goToAdmin('不需要延長管理員的會員期限');
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('role,username')
    .eq('id', userId)
    .single();

  if (!profile || profile.role !== 'member') {
    goToAdmin('找不到一般會員');
  }

  const { data: membership, error: readError } = await admin
    .from('memberships')
    .select('subscription_expires_at')
    .eq('user_id', userId)
    .single();

  if (readError || !membership) {
    goToAdmin('找不到會員期限資料');
  }

  const now = Date.now();

  const previousExpiry = membership.subscription_expires_at
    ? Date.parse(membership.subscription_expires_at)
    : 0;

  // 尚未到期則從原期限延長，已到期則從現在開始
  const start = Math.max(
    now,
    Number.isFinite(previousExpiry) ? previousExpiry : 0
  );

  const newExpiry = new Date(
    start + 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { error } = await admin
    .from('memberships')
    .update({
      subscription_expires_at: newExpiry,
    })
    .eq('user_id', userId);

  if (error) {
    goToAdmin('延長會員期限失敗：' + error.message);
  }

  revalidatePath('/admin');
  goToAdmin(profile.username + ' 已延長 30 天');
}

// 停權或恢復會員
async function toggleSuspension(formData: FormData) {
  'use server';

  const { admin, adminId } = await requireAdmin();

  const userId = getString(formData, 'user_id');
  const operation = getString(formData, 'operation');

  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    goToAdmin('會員 ID 格式錯誤');
  }

  if (userId === adminId) {
    goToAdmin('不可停用自己的管理員帳號');
  }

  if (operation !== 'suspend' && operation !== 'restore') {
    goToAdmin('不支援的管理操作');
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('role,username')
    .eq('id', userId)
    .single();

  if (!profile || profile.role !== 'member') {
    goToAdmin('只能管理一般會員');
  }

  const suspended = operation === 'suspend';

  const { error } = await admin
    .from('memberships')
    .update({ suspended })
    .eq('user_id', userId);

  if (error) {
    goToAdmin('修改會員狀態失敗：' + error.message);
  }

  revalidatePath('/admin');

  goToAdmin(
    profile.username + (suspended ? ' 已停權' : ' 已恢復')
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return '尚未設定';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '日期格式錯誤';
  }

  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  // Next.js 16 cacheComponents：在實際請求時讀取會員資料
  await connection();

  const { admin } = await requireAdmin();

  const { message } = await searchParams;

  const { data: profiles, error: profilesError } =
    await admin
      .from('profiles')
      .select(
        'id,username,line_name,external_member_id,role,created_at'
      )
      .order('created_at', { ascending: false });

  if (profilesError) {
    throw new Error('無法取得會員清單');
  }

  const { data: memberships, error: membershipsError } =
    await admin
      .from('memberships')
      .select(
        'user_id,trial_used,trial_started_at,trial_expires_at,subscription_expires_at,suspended'
      );

  if (membershipsError) {
    throw new Error('無法取得會員期限資料');
  }

  const members = (profiles ?? []) as MemberProfile[];
  const membershipMap = new Map(
    ((memberships ?? []) as Membership[]).map(
      (item) => [item.user_id, item]
    )
  );

  const totalMembers = members.filter(
    (item) => item.role === 'member'
  ).length;

  const suspendedMembers = members.filter(
    (item) =>
      item.role === 'member' &&
      membershipMap.get(item.id)?.suspended
  ).length;

  const now = Date.now();

  return (
    <main className="min-h-screen bg-slate-950 p-5 text-white md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">
              PredictIQ 管理員後台
            </h1>
            <p className="mt-2 text-slate-400">
              會員建立、期限管理與停權控制
            </p>
          </div>

          <a
            href="/dashboard"
            className="rounded-lg bg-slate-800 px-4 py-2 hover:bg-slate-700"
          >
            返回 Dashboard
          </a>
        </header>

        {message && (
          <div
            role="status"
            className="mt-6 rounded-lg border border-sky-700 bg-sky-950 p-4 text-sky-100"
          >
            {message}
          </div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800 p-5">
            <p className="text-slate-400">一般會員總數</p>
            <p className="mt-2 text-3xl font-bold">
              {totalMembers}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 p-5">
            <p className="text-slate-400">已停權會員</p>
            <p className="mt-2 text-3xl font-bold">
              {suspendedMembers}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 p-5">
            <p className="text-slate-400">管理員數量</p>
            <p className="mt-2 text-3xl font-bold">
              {
                members.filter(
                  (item) => item.role === 'admin'
                ).length
              }
            </p>
          </div>
        </div>

        <section className="mt-8 rounded-xl border border-slate-800 p-6">
          <h2 className="text-xl font-bold">建立新會員</h2>

          <p className="mt-2 text-sm text-slate-400">
            新會員首次成功登入後，將依現有登入機制啟動一次 2 小時試用。
          </p>

          <form
            action={createMember}
            className="mt-6 grid gap-4 md:grid-cols-2"
          >
            <label className="block">
              <span className="text-sm text-slate-300">
                會員帳號
              </span>
              <input
                name="username"
                required
                minLength={4}
                maxLength={32}
                pattern="[a-z0-9_]{4,32}"
                placeholder="例如 member001"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3"
              />
            </label>

            <label className="block">
              <span className="text-sm text-slate-300">
                Email
              </span>
              <input
                name="email"
                type="email"
                required
                placeholder="member@example.com"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3"
              />
            </label>

            <label className="block">
              <span className="text-sm text-slate-300">
                初始密碼
              </span>
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                placeholder="至少 12 個字元"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3"
              />
            </label>

            <label className="block">
              <span className="text-sm text-slate-300">
                LINE 顯示名稱
              </span>
              <input
                name="line_name"
                required
                maxLength={100}
                placeholder="會員 LINE 名稱"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="text-sm text-slate-300">
                外部平台會員編號（選填）
              </span>
              <input
                name="external_member_id"
                maxLength={100}
                placeholder="可留空"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3"
              />
            </label>

            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-5 py-3 font-semibold hover:bg-blue-500 md:col-span-2"
            >
              建立會員
            </button>
          </form>
        </section>

        <section className="mt-8 rounded-xl border border-slate-800 p-6">
          <h2 className="text-xl font-bold">會員管理清單</h2>

          <div className="mt-5 space-y-4">
            {members.length === 0 && (
              <p className="text-slate-400">
                目前沒有會員資料
              </p>
            )}

            {members.map((member) => {
              const membership = membershipMap.get(member.id);

              const subscriptionValid =
                !!membership?.subscription_expires_at &&
                Date.parse(
                  membership.subscription_expires_at
                ) > now;

              const trialValid =
                !!membership?.trial_expires_at &&
                Date.parse(
                  membership.trial_expires_at
                ) > now;

              let status = '尚未啟用';

              if (member.role === 'admin') {
                status = '管理員';
              } else if (!membership) {
                status = '會員資料不完整';
              } else if (membership.suspended) {
                status = '已停權';
              } else if (subscriptionValid) {
                status = '正式會員有效';
              } else if (trialValid) {
                status = '試用中';
              } else if (membership.trial_used) {
                status = '已到期';
              }

              return (
                <article
                  key={member.id}
                  className="rounded-xl border border-slate-700 bg-slate-900 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold">
                        {member.username}
                      </h3>

                      <p className="mt-1 text-sm text-slate-400">
                        LINE：{member.line_name || '未填寫'}
                      </p>

                      <p className="mt-1 text-sm text-slate-400">
                        外部編號：
                        {member.external_member_id || '無'}
                      </p>
                    </div>

                    <span className="rounded-full bg-slate-700 px-3 py-1 text-sm">
                      {status}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                    <p>
                      試用資格：
                      {membership?.trial_used
                        ? '已使用'
                        : '尚未使用'}
                    </p>

                    <p>
                      試用到期：
                      {formatDate(
                        membership?.trial_expires_at
                      )}
                    </p>

                    <p>
                      正式會員到期：
                      {formatDate(
                        membership?.subscription_expires_at
                      )}
                    </p>

                    <p>
                      建立時間：
                      {formatDate(member.created_at)}
                    </p>
                  </div>

                  {member.role === 'member' && membership && (
                    <div className="mt-5 flex flex-wrap gap-3">
                      <form action={extendMembership}>
                        <input
                          type="hidden"
                          name="user_id"
                          value={member.id}
                        />
                        <button
                          type="submit"
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500"
                        >
                          延長 30 天
                        </button>
                      </form>

                      <form action={toggleSuspension}>
                        <input
                          type="hidden"
                          name="user_id"
                          value={member.id}
                        />
                        <input
                          type="hidden"
                          name="operation"
                          value={
                            membership.suspended
                              ? 'restore'
                              : 'suspend'
                          }
                        />
                        <button
                          type="submit"
                          className="rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
                        >
                          {membership.suspended
                            ? '恢復會員'
                            : '停權會員'}
                        </button>
                      </form>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
