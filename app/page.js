'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import StockWorkflow from '@/components/StockWorkflow';
import ReportsDashboard from '@/components/ReportsDashboard';

export default function AtlasDepoApp() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [authLoading, setAuthLoading] = useState(true);

  // Giriş formu durumları
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Veritabanı verileri
  const [locations, setLocations] = useState([]);
  const [products, setProducts] = useState([]);
  const [stocks, setStocks] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');

  // Depo sorumlusu ana menü durumu: 'MENU' | 'OPERATIONS' | 'REPORTS'
  const [supervisorView, setSupervisorView] = useState('MENU');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user) {
      setSupervisorView('MENU');
      loadAllData(session.user.id);
    } else {
      setProfile(null);
      setProfiles([]);
      setLocations([]);
      setProducts([]);
      setStocks([]);
      setTransactions([]);
      setSupervisorView('MENU');
    }
  }, [session]);

  async function loadAllData(userId) {
    setDataLoading(true);
    setDataError('');

    const [profRes, allProfRes, locRes, prodRes, stockRes, txRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('profiles').select('*'),
      supabase.from('locations').select('*').order('warehouse_code').order('shelf_code'),
      supabase.from('products').select('*').order('sku'),
      supabase.from('stocks').select('*'),
      supabase
        .from('stock_transactions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(250),
    ]);

    const firstError = locRes.error || prodRes.error || stockRes.error || txRes.error;
    if (firstError) {
      setDataError(`Veritabanı okuma hatası: ${firstError.message}`);
    }

    if (profRes.data) setProfile(profRes.data);
    if (allProfRes.data) setProfiles(allProfRes.data);
    if (locRes.data) setLocations(locRes.data);
    if (prodRes.data) setProducts(prodRes.data);
    if (stockRes.data) setStocks(stockRes.data);
    if (txRes.data) setTransactions(txRes.data);
    setDataLoading(false);
  }

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setLoginError('Giriş başarısız: E-posta veya şifre hatalı.');
    }
    setLoginLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  const isSupervisor = profile?.role === 'sorumlu';

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 text-slate-700 font-medium">
        Sistem yükleniyor...
      </div>
    );
  }

  // GİRİŞ EKRANI
  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 sm:p-8">
          <div className="mb-6">
            <span className="inline-block px-3 py-1 text-xs font-semibold bg-blue-100 text-blue-800 rounded-full mb-2">
              CENG 409 • Mobil Depo ve Stok Takip
            </span>
            <h1 className="text-2xl font-bold text-slate-900">Atlas Depo Sistemi</h1>
            <p className="text-sm text-slate-500 mt-1">
              Devam etmek için kullanıcı hesabınızla giriş yapın.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">E-posta Adresi</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ornek@atlasdepo.com"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Şifre</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>

            {loginError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2.5 rounded-lg transition"
            >
              {loginLoading ? 'Giriş yapılıyor...' : 'Sisteme Giriş Yap'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-200">
            <p className="text-xs font-medium text-slate-500 mb-2">Hızlı Test Hesabı Doldur:</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setEmail('sorumlu@atlasdepo.com');
                  setPassword('Atlas123!');
                }}
                className="text-xs py-2 px-3 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium"
              >
                Depo Sorumlusu
              </button>
              <button
                type="button"
                onClick={() => {
                  setEmail('personel@atlasdepo.com');
                  setPassword('Atlas123!');
                }}
                className="text-xs py-2 px-3 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium"
              >
                Depo Personeli
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Üst Çubuk */}
      <header className="bg-slate-900 text-white sticky top-0 z-20 shadow">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Atlas Depo Takip</h1>
            <p className="text-xs text-slate-300">
              {profile?.full_name || session.user.email} •{' '}
              <span className="uppercase font-semibold text-amber-300">
                {isSupervisor ? 'Depo Sorumlusu' : 'Depo Personeli'}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadAllData(session.user.id)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700"
            >
              Yenile
            </button>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700"
            >
              Çıkış Yap
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {dataError && (
          <div className="mb-5 p-4 rounded-xl bg-red-50 border border-red-300 text-sm text-red-800 font-medium">
            {dataError}
          </div>
        )}

        {/* DEPO SORUMLUSU İLK GİRİŞ EKRANI (2 SEÇENEK: İŞLEM YAP / RAPORLAR) */}
        {isSupervisor && supervisorView === 'MENU' ? (
          <div className="max-w-3xl mx-auto space-y-6 pt-4">
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
              <span className="inline-block px-3 py-1 text-xs font-semibold bg-amber-100 text-amber-800 rounded-full mb-2">
                Depo Sorumlusu Kontrol Paneli
              </span>
              <h2 className="text-2xl font-bold text-slate-900">Hoş Geldiniz, Ne Yapmak İstersiniz?</h2>
              <p className="text-sm text-slate-500 mt-1">
                Depo operasyonlarını yürütmek için <strong>İşlem Yap</strong> bölümünü, stok ve personel analizlerini incelemek için <strong>Raporlar</strong> bölümünü seçin.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* 1. SEÇENEK: İŞLEM YAP */}
              <button
                type="button"
                onClick={() => setSupervisorView('OPERATIONS')}
                className="text-left bg-white hover:border-blue-600 hover:shadow-lg rounded-2xl p-6 shadow-sm border-2 border-slate-200 transition flex flex-col justify-between space-y-5"
              >
                <div className="space-y-2">
                  <span className="inline-block px-3 py-1 text-xs font-bold bg-blue-100 text-blue-800 rounded-lg">
                    1. Seçenek
                  </span>
                  <h3 className="text-2xl font-bold text-slate-900">İşlem Yap</h3>
                  <p className="text-sm text-slate-600">
                    Depo seçimi yapın, tekli veya çoklu ürün seçerek <strong>Stok Girişi, Stok Çıkışı, Depo/Raf Transferi, Sayım-Düzeltme</strong> ve <strong>Stok Sorgulama</strong> işlemlerini uygulayın.
                  </p>
                </div>

                <div className="w-full py-3 text-center rounded-xl bg-blue-600 text-white font-bold text-sm">
                  İşlem Ekranını Aç →
                </div>
              </button>

              {/* 2. SEÇENEK: RAPORLAR */}
              <button
                type="button"
                onClick={() => setSupervisorView('REPORTS')}
                className="text-left bg-white hover:border-slate-900 hover:shadow-lg rounded-2xl p-6 shadow-sm border-2 border-slate-200 transition flex flex-col justify-between space-y-5"
              >
                <div className="space-y-2">
                  <span className="inline-block px-3 py-1 text-xs font-bold bg-amber-100 text-amber-800 rounded-lg">
                    2. Seçenek
                  </span>
                  <h3 className="text-2xl font-bold text-slate-900">Raporlar</h3>
                  <p className="text-sm text-slate-600">
                    <strong>Stok Hareketleri, Kritik Stok Seviyeleri, Sayım Farkları</strong> ve <strong>Kullanıcı Bazlı İşlem Geçmişi</strong> raporlarını filtreleyip inceleyin.
                  </p>
                </div>

                <div className="w-full py-3 text-center rounded-xl bg-slate-900 text-white font-bold text-sm">
                  Raporlar Ekranını Aç →
                </div>
              </button>
            </div>
          </div>
        ) : isSupervisor && supervisorView === 'REPORTS' ? (
          <ReportsDashboard
            locations={locations}
            products={products}
            stocks={stocks}
            transactions={transactions}
            profiles={profiles}
            onBack={() => setSupervisorView('MENU')}
            onRefresh={() => loadAllData(session.user.id)}
          />
        ) : (
          <StockWorkflow
            session={session}
            profile={profile}
            locations={locations}
            products={products}
            stocks={stocks}
            transactions={transactions}
            dataLoading={dataLoading}
            onReloadData={loadAllData}
            onBackToMenu={isSupervisor ? () => setSupervisorView('MENU') : null}
          />
        )}
      </main>
    </div>
  );
}