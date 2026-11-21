'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function AtlasDepoApp() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
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
  const [dataLoading, setDataLoading] = useState(false);

  // Filtreler
  const [selectedWarehouse, setSelectedWarehouse] = useState('ALL');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyCritical, setOnlyCritical] = useState(false);

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
      loadAllData(session.user.id);
    } else {
      setProfile(null);
      setLocations([]);
      setProducts([]);
      setStocks([]);
    }
  }, [session]);

  async function loadAllData(userId) {
    setDataLoading(true);
    const [profRes, locRes, prodRes, stockRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('locations').select('*').order('warehouse_code').order('shelf_code'),
      supabase.from('products').select('*').order('sku'),
      supabase.from('stocks').select('*'),
    ]);

    if (profRes.data) setProfile(profRes.data);
    if (locRes.data) setLocations(locRes.data);
    if (prodRes.data) setProducts(prodRes.data);
    if (stockRes.data) setStocks(stockRes.data);
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

  // Stok satırlarını ürün ve depo/raf bilgisiyle birleştir
  const enrichedStocks = useMemo(() => {
    const productMap = new Map(products.map((p) => [p.id, p]));
    const locationMap = new Map(locations.map((l) => [l.id, l]));

    return stocks
      .map((s) => {
        const product = productMap.get(s.product_id);
        const location = locationMap.get(s.location_id);
        if (!product || !location) return null;
        return {
          ...s,
          product,
          location,
          isCritical: s.quantity <= product.min_stock_level,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.location.warehouse_code !== b.location.warehouse_code) {
          return a.location.warehouse_code.localeCompare(b.location.warehouse_code);
        }
        return a.product.sku.localeCompare(b.product.sku);
      });
  }, [stocks, products, locations]);

  const categories = useMemo(() => {
    return Array.from(new Set(products.map((p) => p.category)));
  }, [products]);

  const filteredStocks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedStocks.filter((row) => {
      if (selectedWarehouse !== 'ALL' && row.location.warehouse_code !== selectedWarehouse) {
        return false;
      }
      if (selectedCategory !== 'ALL' && row.product.category !== selectedCategory) {
        return false;
      }
      if (onlyCritical && !row.isCritical) {
        return false;
      }
      if (q) {
        const matchSku = row.product.sku.toLowerCase().includes(q);
        const matchName = row.product.name.toLowerCase().includes(q);
        const matchBrand = row.product.brand.toLowerCase().includes(q);
        const matchShelf = row.location.shelf_code.toLowerCase().includes(q);
        return matchSku || matchName || matchBrand || matchShelf;
      }
      return true;
    });
  }, [enrichedStocks, selectedWarehouse, selectedCategory, onlyCritical, searchQuery]);

  const stats = useMemo(() => {
    const scopeRows =
      selectedWarehouse === 'ALL'
        ? enrichedStocks
        : enrichedStocks.filter((r) => r.location.warehouse_code === selectedWarehouse);

    const totalUnits = scopeRows.reduce((acc, r) => acc + r.quantity, 0);
    const criticalCount = scopeRows.filter((r) => r.isCritical).length;
    return {
      recordCount: scopeRows.length,
      totalUnits,
      criticalCount,
    };
  }, [enrichedStocks, selectedWarehouse]);

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
              Pamukkale, Merkezefendi ve Acıpayam depoları için kullanıcı girişi yapın.
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

  // ANA UYGULAMA EKRANI (STOK SORGULAMA VE KRİTİK UYARILAR)
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Üst Başlık */}
      <header className="bg-slate-900 text-white sticky top-0 z-20 shadow">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Atlas Depo Takip</h1>
            <p className="text-xs text-slate-300">
              {profile?.full_name || session.user.email} •{' '}
              <span className="uppercase font-semibold text-amber-300">
                {profile?.role === 'sorumlu' ? 'Depo Sorumlusu' : 'Depo Personeli'}
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

      <main className="max-w-7xl mx-auto px-4 py-5 space-y-5">
        {/* Özet Kartlar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
            <p className="text-xs font-medium text-slate-500">Kayıtlı Stok Kalemi</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{stats.recordCount}</p>
            <p className="text-xs text-slate-400 mt-0.5">53 ürün • 36 raf bölgesi</p>
          </div>

          <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
            <p className="text-xs font-medium text-slate-500">Toplam Fiziksel Stok</p>
            <p className="text-2xl font-bold text-blue-700 mt-1">
              {stats.totalUnits.toLocaleString('tr-TR')}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">Koli / Paket / Şişe / Kutu toplamı</p>
          </div>

          <button
            type="button"
            onClick={() => setOnlyCritical((prev) => !prev)}
            className={`text-left rounded-xl p-4 shadow-sm border transition ${
              onlyCritical
                ? 'bg-red-600 text-white border-red-700'
                : 'bg-white text-slate-900 border-slate-200 hover:border-red-300'
            }`}
          >
            <p className={`text-xs font-medium ${onlyCritical ? 'text-red-100' : 'text-slate-500'}`}>
              Kritik Stok Uyarısı {onlyCritical ? '(Filtre Açık)' : '(Filtrelemek için dokun)'}
            </p>
            <p
              className={`text-2xl font-bold mt-1 ${
                onlyCritical ? 'text-white' : stats.criticalCount > 0 ? 'text-red-600' : 'text-emerald-600'
              }`}
            >
              {stats.criticalCount} Ürün
            </p>
            <p className={`text-xs mt-0.5 ${onlyCritical ? 'text-red-100' : 'text-slate-400'}`}>
              Eşik değer ve altındaki kalemler
            </p>
          </button>
        </div>

        {/* Depo Sekmeleri ve Arama Filtreleri */}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200 space-y-3">
          <div className="flex flex-wrap gap-2">
            {[
              { code: 'ALL', label: 'Tüm Depolar (3)' },
              { code: 'DEPO-1', label: 'Pamukkale Depo' },
              { code: 'DEPO-2', label: 'Merkezefendi Depo' },
              { code: 'DEPO-3', label: 'Acıpayam Depo' },
            ].map((w) => (
              <button
                key={w.code}
                onClick={() => setSelectedWarehouse(w.code)}
                className={`px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition ${
                  selectedWarehouse === w.code
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ürün kodu (KHV001), ürün adı, marka veya raf (A1) ara..."
              className="sm:col-span-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:border-blue-600 focus:outline-none"
            >
              <option value="ALL">Tüm Kategoriler</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Stok Listesi Tablosu */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          {dataLoading ? (
            <div className="p-8 text-center text-sm text-slate-500">Veriler yükleniyor...</div>
          ) : filteredStocks.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Arama kriterine uygun stok kaydı bulunamadı.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500">
                    <th className="py-3 px-4">Kod</th>
                    <th className="py-3 px-4">Ürün / Marka</th>
                    <th className="py-3 px-4">Depo & Raf</th>
                    <th className="py-3 px-4">Birim / Ambalaj</th>
                    <th className="py-3 px-4 text-right">Mevcut Stok</th>
                    <th className="py-3 px-4 text-right">Kritik Eşik</th>
                    <th className="py-3 px-4 text-center">Durum</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredStocks.map((row) => (
                    <tr
                      key={row.id}
                      className={row.isCritical ? 'bg-red-50/70' : 'hover:bg-slate-50'}
                    >
                      <td className="py-3 px-4 font-mono font-semibold text-xs text-slate-800">
                        {row.product.sku}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{row.product.name}</div>
                        <div className="text-xs text-slate-500">
                          {row.product.brand} • {row.product.category}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-800">
                          {row.location.warehouse_name}
                        </div>
                        <span className="inline-block mt-0.5 px-2 py-0.5 text-xs font-mono font-semibold bg-slate-200 text-slate-800 rounded">
                          Raf: {row.location.shelf_code}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-600">
                        {row.product.unit} ({row.product.pack_detail})
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-base text-slate-900">
                        {row.quantity}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-500">
                        {row.product.min_stock_level}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {row.isCritical ? (
                          <span className="inline-block px-2.5 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-700">
                            Kritik Seviye
                          </span>
                        ) : (
                          <span className="inline-block px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-700">
                            Normal
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}