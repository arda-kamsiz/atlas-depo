'use client';

import { useMemo, useState } from 'react';

const WAREHOUSES = [
  { code: 'DEPO-1', name: 'Pamukkale Depo' },
  { code: 'DEPO-2', name: 'Merkezefendi Depo' },
  { code: 'DEPO-3', name: 'Acıpayam Depo' },
];

const TX_LABELS = {
  GIRIS: { label: 'Stok Girişi', badge: 'bg-emerald-100 text-emerald-800' },
  CIKIS: { label: 'Stok Çıkışı', badge: 'bg-amber-100 text-amber-800' },
  TRANSFER: { label: 'Depo/Raf Transferi', badge: 'bg-blue-100 text-blue-800' },
  SAYIM: { label: 'Sayım-Düzeltme', badge: 'bg-purple-100 text-purple-800' },
};

export default function ReportsDashboard({
  locations,
  products,
  stocks,
  transactions,
  profiles,
  onBack,
  onRefresh,
}) {
  // 'MOVEMENTS' | 'CRITICAL' | 'COUNT_DIFFS' | 'USER_HISTORY'
  const [reportTab, setReportTab] = useState('MOVEMENTS');

  // Ortak filtreler
  const [warehouseFilter, setWarehouseFilter] = useState('ALL');
  const [txTypeFilter, setTxTypeFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUserEmail, setSelectedUserEmail] = useState('ALL');

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const locationMap = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))),
    [products]
  );

  // Zenginleştirilmiş stok hareketleri
  const enrichedTransactions = useMemo(() => {
    return transactions.map((tx) => {
      const product = productMap.get(tx.product_id);
      const sourceLoc = tx.source_location_id ? locationMap.get(tx.source_location_id) : null;
      const targetLoc = tx.target_location_id ? locationMap.get(tx.target_location_id) : null;
      const diff = tx.new_qty - tx.previous_qty;

      return {
        ...tx,
        product,
        sourceLoc,
        targetLoc,
        diff,
      };
    });
  }, [transactions, productMap, locationMap]);

  // 1. RAPOR: STOK HAREKETLERİ FİLTRESİ
  const filteredMovements = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedTransactions.filter((tx) => {
      if (txTypeFilter !== 'ALL' && tx.tx_type !== txTypeFilter) return false;
      if (warehouseFilter !== 'ALL') {
        const matchSource = tx.sourceLoc?.warehouse_code === warehouseFilter;
        const matchTarget = tx.targetLoc?.warehouse_code === warehouseFilter;
        if (!matchSource && !matchTarget) return false;
      }
      if (q) {
        const sku = tx.product?.sku?.toLowerCase() || '';
        const name = tx.product?.name?.toLowerCase() || '';
        const note = tx.note?.toLowerCase() || '';
        const email = tx.performer_email?.toLowerCase() || '';
        if (!sku.includes(q) && !name.includes(q) && !note.includes(q) && !email.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [enrichedTransactions, txTypeFilter, warehouseFilter, searchQuery]);

  // 2. RAPOR: KRİTİK STOK SEVİYELERİ
  const criticalStockRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const rows = [];

    WAREHOUSES.forEach((w) => {
      if (warehouseFilter !== 'ALL' && w.code !== warehouseFilter) return;

      const wLocs = locations.filter((l) => l.warehouse_code === w.code);
      const normalLocIds = new Set(
        wLocs.filter((l) => !l.shelf_code.startsWith('K')).map((l) => l.id)
      );
      const kLocIds = new Set(
        wLocs.filter((l) => l.shelf_code.startsWith('K')).map((l) => l.id)
      );

      products.forEach((prod) => {
        if (categoryFilter !== 'ALL' && prod.category !== categoryFilter) return;

        const usableStocks = stocks.filter(
          (s) => s.product_id === prod.id && normalLocIds.has(s.location_id)
        );
        const kStocks = stocks.filter(
          (s) => s.product_id === prod.id && kLocIds.has(s.location_id)
        );

        const usableQty = usableStocks.reduce((acc, s) => acc + s.quantity, 0);
        const spoiledQty = kStocks.reduce((acc, s) => acc + s.quantity, 0);

        if (usableQty <= prod.min_stock_level) {
          if (q) {
            const matchSku = prod.sku.toLowerCase().includes(q);
            const matchName = prod.name.toLowerCase().includes(q);
            if (!matchSku && !matchName) return;
          }

          const shelfCodes =
            usableStocks.length > 0
              ? usableStocks
                  .map((s) => locationMap.get(s.location_id)?.shelf_code)
                  .filter(Boolean)
                  .join(', ')
              : wLocs.find((l) => !l.shelf_code.startsWith('K'))?.shelf_code || '-';

          rows.push({
            key: `${w.code}-${prod.id}`,
            warehouse: w,
            product: prod,
            shelfCodes,
            usableQty,
            spoiledQty,
            deficit: Math.max(0, prod.min_stock_level - usableQty),
          });
        }
      });
    });

    return rows.sort((a, b) => b.deficit - a.deficit);
  }, [locations, products, stocks, locationMap, warehouseFilter, categoryFilter, searchQuery]);

  // 3. RAPOR: SAYIM FARKLARI
  const countDiffRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedTransactions.filter((tx) => {
      if (tx.tx_type !== 'SAYIM') return false;
      if (warehouseFilter !== 'ALL' && tx.sourceLoc?.warehouse_code !== warehouseFilter) {
        return false;
      }
      if (q) {
        const sku = tx.product?.sku?.toLowerCase() || '';
        const name = tx.product?.name?.toLowerCase() || '';
        if (!sku.includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
  }, [enrichedTransactions, warehouseFilter, searchQuery]);

  // 4. RAPOR: KULLANICI BAZLI İŞLEM ÖZETİ VE LİSTESİ
  const userSummaries = useMemo(() => {
    const map = new Map();

    profiles.forEach((p) => {
      if (p.email) {
        map.set(p.email, {
          email: p.email,
          fullName: p.full_name || p.email,
          role: p.role || 'personel',
          total: 0,
          giris: 0,
          cikis: 0,
          transfer: 0,
          sayim: 0,
          lastDate: null,
        });
      }
    });

    enrichedTransactions.forEach((tx) => {
      const email = tx.performer_email || 'Bilinmeyen';
      if (!map.has(email)) {
        map.set(email, {
          email,
          fullName: email,
          role: tx.performer_role || 'personel',
          total: 0,
          giris: 0,
          cikis: 0,
          transfer: 0,
          sayim: 0,
          lastDate: null,
        });
      }
      const entry = map.get(email);
      entry.total += 1;
      if (tx.tx_type === 'GIRIS') entry.giris += 1;
      if (tx.tx_type === 'CIKIS') entry.cikis += 1;
      if (tx.tx_type === 'TRANSFER') entry.transfer += 1;
      if (tx.tx_type === 'SAYIM') entry.sayim += 1;
      if (!entry.lastDate || new Date(tx.created_at) > new Date(entry.lastDate)) {
        entry.lastDate = tx.created_at;
      }
    });

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [profiles, enrichedTransactions]);

  const userFilteredTransactions = useMemo(() => {
    if (selectedUserEmail === 'ALL') return enrichedTransactions;
    return enrichedTransactions.filter((tx) => tx.performer_email === selectedUserEmail);
  }, [enrichedTransactions, selectedUserEmail]);

  function switchReportTab(tab) {
    setReportTab(tab);
    setSearchQuery('');
    setWarehouseFilter('ALL');
    setTxTypeFilter('ALL');
    setCategoryFilter('ALL');
  }

  return (
    <div className="space-y-5">
      {/* Üst Başlık ve Geri Dönüş */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="inline-block px-2.5 py-0.5 text-xs font-semibold bg-amber-100 text-amber-800 rounded-full mb-1">
            Depo Sorumlusu Yönetim Paneli
          </span>
          <h2 className="text-xl font-bold text-slate-900">Depo Analiz ve Denetim Raporları</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Stok hareketlerini, kritik stok eşiklerini, sayım farklarını ve personel işlem geçmişini inceleyin.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
          >
            Verileri Güncelle
          </button>
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 hover:bg-slate-800 text-white"
          >
            ← Ana Menüye Dön
          </button>
        </div>
      </div>

      {/* 4 RAPOR SEÇENEĞİ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          {
            id: 'MOVEMENTS',
            title: '1. Stok Hareketleri',
            count: `${transactions.length} İşlem`,
            desc: 'Tüm giriş, çıkış, transfer ve sayım kayıtları',
          },
          {
            id: 'CRITICAL',
            title: '2. Kritik Stok Seviyeleri',
            count: `${criticalStockRows.length} Uyarı`,
            desc: 'Minimum stok eşiği ve altındaki kalemler',
          },
          {
            id: 'COUNT_DIFFS',
            title: '3. Sayım Farkları',
            count: `${enrichedTransactions.filter((t) => t.tx_type === 'SAYIM').length} Sayım`,
            desc: 'Sistem stoğu ile fiziksel sayım sapmaları',
          },
          {
            id: 'USER_HISTORY',
            title: '4. Kullanıcı Bazlı Geçmiş',
            count: `${userSummaries.length} Kullanıcı`,
            desc: 'Sorumlu ve personel bazında işlem dökümü',
          },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => switchReportTab(tab.id)}
            className={`text-left p-4 rounded-xl border-2 transition ${
              reportTab === tab.id
                ? 'bg-blue-600 text-white border-blue-700 shadow-sm'
                : 'bg-white text-slate-900 border-slate-200 hover:border-blue-400'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold">{tab.title}</span>
            </div>
            <div
              className={`text-lg font-extrabold mt-1 ${
                reportTab === tab.id ? 'text-white' : 'text-blue-700'
              }`}
            >
              {tab.count}
            </div>
            <p
              className={`text-xs mt-1 ${
                reportTab === tab.id ? 'text-blue-100' : 'text-slate-500'
              }`}
            >
              {tab.desc}
            </p>
          </button>
        ))}
      </div>

      {/* =================================================================
          RAPOR 1: STOK HAREKETLERİ
         ================================================================= */}
      {reportTab === 'MOVEMENTS' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ürün kodu, ürün adı, kullanıcı veya not ara..."
              className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={warehouseFilter}
              onChange={(e) => setWarehouseFilter(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="ALL">Tüm Depolar (3)</option>
              {WAREHOUSES.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.name}
                </option>
              ))}
            </select>
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="ALL">Tüm İşlem Türleri</option>
              <option value="GIRIS">Stok Girişi</option>
              <option value="CIKIS">Stok Çıkışı</option>
              <option value="TRANSFER">Depo/Raf Transferi</option>
              <option value="SAYIM">Sayım-Düzeltme</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-3 px-4">Tarih</th>
                  <th className="py-3 px-4">İşlem</th>
                  <th className="py-3 px-4">Ürün</th>
                  <th className="py-3 px-4">Depo & Raf</th>
                  <th className="py-3 px-4 text-right">Stok Değişimi</th>
                  <th className="py-3 px-4">İşlemi Yapan</th>
                  <th className="py-3 px-4">Not</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredMovements.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500">
                      Filtreye uygun stok hareketi bulunamadı.
                    </td>
                  </tr>
                ) : (
                  filteredMovements.map((tx) => {
                    const badge = TX_LABELS[tx.tx_type] || {
                      label: tx.tx_type,
                      badge: 'bg-slate-100 text-slate-800',
                    };
                    return (
                      <tr key={tx.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 whitespace-nowrap text-xs text-slate-600">
                          {new Date(tx.created_at).toLocaleString('tr-TR')}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2.5 py-0.5 text-xs font-semibold rounded-full ${badge.badge}`}
                          >
                            {badge.label}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">
                            {tx.product?.sku} • {tx.product?.name}
                          </div>
                          <div className="text-xs text-slate-500">{tx.product?.brand}</div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-700">
                          {tx.sourceLoc && (
                            <div>
                              Kaynak: {tx.sourceLoc.warehouse_name} ({tx.sourceLoc.shelf_code})
                            </div>
                          )}
                          {tx.targetLoc && (
                            <div>
                              Hedef: {tx.targetLoc.warehouse_name} ({tx.targetLoc.shelf_code})
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <span className="font-bold text-slate-900">
                            {tx.previous_qty} → {tx.new_qty}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className="font-medium text-slate-800">{tx.performer_email}</div>
                          <div className="uppercase text-slate-400">{tx.performer_role}</div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600">{tx.note || '-'}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =================================================================
          RAPOR 2: KRİTİK STOK SEVİYELERİ
         ================================================================= */}
      {reportTab === 'CRITICAL' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ürün kodu veya adı ara..."
              className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={warehouseFilter}
              onChange={(e) => setWarehouseFilter(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="ALL">Tüm Depolar (3)</option>
              {WAREHOUSES.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.name}
                </option>
              ))}
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="ALL">Tüm Kategoriler</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-3 px-4">Depo / Raf</th>
                  <th className="py-3 px-4">Ürün Kodu</th>
                  <th className="py-3 px-4">Ürün / Kategori</th>
                  <th className="py-3 px-4 text-right">Kullanılabilir Stok</th>
                  <th className="py-3 px-4 text-right">Kritik Eşik</th>
                  <th className="py-3 px-4 text-right">Eksik Miktar</th>
                  <th className="py-3 px-4 text-right">K Bloğu (Bozuk)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {criticalStockRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-emerald-700 font-medium">
                      Seçili filtrede kritik stok seviyesinin altında ürün bulunmuyor.
                    </td>
                  </tr>
                ) : (
                  criticalStockRows.map((row) => (
                    <tr key={row.key} className="bg-red-50/50 hover:bg-red-50">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{row.warehouse.name}</div>
                        <span className="text-xs font-mono bg-slate-200 px-1.5 py-0.5 rounded">
                          Raf: {row.shelfCodes}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-xs">{row.product.sku}</td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{row.product.name}</div>
                        <div className="text-xs text-slate-500">
                          {row.product.brand} • {row.product.category}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-red-600">
                        {row.usableQty} {row.product.unit}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-600">
                        {row.product.min_stock_level} {row.product.unit}
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-red-700">
                        {row.deficit > 0 ? `-${row.deficit}` : 'Eşik Sınırında'}
                      </td>
                      <td className="py-3 px-4 text-right text-xs text-slate-600">
                        {row.spoiledQty > 0 ? (
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">
                            {row.spoiledQty} {row.product.unit}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =================================================================
          RAPOR 3: SAYIM FARKLARI
         ================================================================= */}
      {reportTab === 'COUNT_DIFFS' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Sayım yapılan ürün kodu veya adı ara..."
              className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={warehouseFilter}
              onChange={(e) => setWarehouseFilter(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="ALL">Tüm Depolar (3)</option>
              {WAREHOUSES.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500">
                  <th className="py-3 px-4">Sayım Tarihi</th>
                  <th className="py-3 px-4">Depo & Raf</th>
                  <th className="py-3 px-4">Ürün</th>
                  <th className="py-3 px-4 text-right">Sistem Stoğu</th>
                  <th className="py-3 px-4 text-right">Fiziksel Sayım</th>
                  <th className="py-3 px-4 text-right">Sayım Farkı</th>
                  <th className="py-3 px-4">Sayan Sorumlu</th>
                  <th className="py-3 px-4">Açıklama</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {countDiffRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500">
                      Henüz kaydedilmiş bir sayım düzeltme kaydı bulunmuyor.
                    </td>
                  </tr>
                ) : (
                  countDiffRows.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {new Date(tx.created_at).toLocaleString('tr-TR')}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="font-semibold text-slate-900">
                          {tx.sourceLoc?.warehouse_name || '-'}
                        </div>
                        <div className="font-mono text-slate-500">
                          Raf: {tx.sourceLoc?.shelf_code || '-'}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">
                          {tx.product?.sku} • {tx.product?.name}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right text-slate-600">{tx.previous_qty}</td>
                      <td className="py-3 px-4 text-right font-bold text-slate-900">
                        {tx.new_qty}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span
                          className={`px-2.5 py-0.5 text-xs font-bold rounded-full ${
                            tx.diff < 0
                              ? 'bg-red-100 text-red-700'
                              : tx.diff > 0
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {tx.diff > 0 ? `+${tx.diff}` : tx.diff}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">{tx.performer_email}</td>
                      <td className="py-3 px-4 text-xs text-slate-500">{tx.note || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =================================================================
          RAPOR 4: KULLANICI BAZLI İŞLEM GEÇMİŞİ
         ================================================================= */}
      {reportTab === 'USER_HISTORY' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => setSelectedUserEmail('ALL')}
              className={`text-left p-4 rounded-xl border-2 transition ${
                selectedUserEmail === 'ALL'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-900 border-slate-200 hover:border-slate-400'
              }`}
            >
              <div className="text-xs uppercase opacity-75">Tüm Personel</div>
              <div className="text-lg font-bold mt-0.5">Tüm Kullanıcılar</div>
              <div className="text-xs mt-2 opacity-85">
                Toplam {enrichedTransactions.length} sistem işlemi
              </div>
            </button>

            {userSummaries.map((u) => (
              <button
                key={u.email}
                type="button"
                onClick={() => setSelectedUserEmail(u.email)}
                className={`text-left p-4 rounded-xl border-2 transition ${
                  selectedUserEmail === u.email
                    ? 'bg-blue-600 text-white border-blue-700'
                    : 'bg-white text-slate-900 border-slate-200 hover:border-blue-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`px-2 py-0.5 text-[11px] font-bold uppercase rounded ${
                      selectedUserEmail === u.email
                        ? 'bg-blue-500 text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {u.role === 'sorumlu' ? 'Depo Sorumlusu' : 'Depo Personeli'}
                  </span>
                  <span className="text-sm font-extrabold">{u.total} İşlem</span>
                </div>
                <div className="font-bold text-sm mt-2 truncate">{u.email}</div>
                <div
                  className={`text-xs mt-2 flex flex-wrap gap-2 ${
                    selectedUserEmail === u.email ? 'text-blue-100' : 'text-slate-500'
                  }`}
                >
                  <span>Giriş: {u.giris}</span>
                  <span>• Çıkış: {u.cikis}</span>
                  <span>• Transfer: {u.transfer}</span>
                  <span>• Sayım: {u.sayim}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200">
              <h3 className="text-sm font-bold text-slate-900">
                {selectedUserEmail === 'ALL'
                  ? 'Tüm Kullanıcıların İşlem Dökümü'
                  : `${selectedUserEmail} Kullanıcısının İşlemleri (${userFilteredTransactions.length})`}
              </h3>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500">
                    <th className="py-3 px-4">Tarih</th>
                    <th className="py-3 px-4">Kullanıcı</th>
                    <th className="py-3 px-4">İşlem</th>
                    <th className="py-3 px-4">Ürün</th>
                    <th className="py-3 px-4">Konum</th>
                    <th className="py-3 px-4 text-right">Değişim</th>
                    <th className="py-3 px-4">Not</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {userFilteredTransactions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-500">
                        Bu kullanıcıya ait işlem kaydı bulunmuyor.
                      </td>
                    </tr>
                  ) : (
                    userFilteredTransactions.map((tx) => {
                      const badge = TX_LABELS[tx.tx_type] || {
                        label: tx.tx_type,
                        badge: 'bg-slate-100 text-slate-800',
                      };
                      return (
                        <tr key={tx.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 whitespace-nowrap text-xs text-slate-600">
                            {new Date(tx.created_at).toLocaleString('tr-TR')}
                          </td>
                          <td className="py-3 px-4 text-xs font-medium text-slate-800">
                            {tx.performer_email}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`px-2.5 py-0.5 text-xs font-semibold rounded-full ${badge.badge}`}
                            >
                              {badge.label}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-semibold text-slate-900">
                            {tx.product?.sku} • {tx.product?.name}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">
                            {tx.sourceLoc && (
                              <div>
                                Kaynak: {tx.sourceLoc.warehouse_name} ({tx.sourceLoc.shelf_code})
                              </div>
                            )}
                            {tx.targetLoc && (
                              <div>
                                Hedef: {tx.targetLoc.warehouse_name} ({tx.targetLoc.shelf_code})
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-bold">
                            {tx.previous_qty} → {tx.new_qty}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-500">{tx.note || '-'}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}