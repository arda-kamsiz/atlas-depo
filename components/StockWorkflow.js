'use client';

import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

function generateIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Kategoriye göre bozuk / karantina K bloğu raf eşleşmesi
function getKBlockShelfForCategory(category) {
  const c = (category || '').toLocaleLowerCase('tr-TR');
  if (c.includes('kahve')) return 'K1';
  if (c.includes('çay') || c.includes('cay')) return 'K2';
  if (c.includes('şurup') || c.includes('surup') || c.includes('sos')) return 'K3';
  if (c.includes('süt') || c.includes('sut')) return 'K4';
  if (c.includes('soft') || c.includes('içecek') || c.includes('icecek')) return 'K5';
  if (c.includes('ambalaj')) return 'K6';
  return 'K1';
}

const WAREHOUSES = [
  { code: 'DEPO-1', name: 'Pamukkale Depo', district: 'Pamukkale / Denizli' },
  { code: 'DEPO-2', name: 'Merkezefendi Depo', district: 'Merkezefendi / Denizli' },
  { code: 'DEPO-3', name: 'Acıpayam Depo', district: 'Acıpayam / Denizli' },
];

const TX_LABELS = {
  GIRIS: { label: 'Stok Girişi', badge: 'bg-emerald-100 text-emerald-800' },
  CIKIS: { label: 'Stok Çıkışı', badge: 'bg-amber-100 text-amber-800' },
  TRANSFER: { label: 'Depo/Raf Transferi', badge: 'bg-blue-100 text-blue-800' },
  SAYIM: { label: 'Sayım-Düzeltme', badge: 'bg-purple-100 text-purple-800' },
};

export default function StockWorkflow({
  session,
  profile,
  locations,
  products,
  stocks,
  transactions,
  dataLoading,
  onReloadData,
  onBackToMenu,
}) {
  // Adım 1: Seçili Kaynak Depo
  const [selectedWarehouse, setSelectedWarehouse] = useState('');

  // Adım 2: Ürün Filtreleri & Çoklu Seçim
  const [productSearch, setProductSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [onlyCritical, setOnlyCritical] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [isStep3Active, setIsStep3Active] = useState(false);

  // Adım 3: Seçili İşlem ve Ortak / Ürün Bazlı Değerler
  const [selectedAction, setSelectedAction] = useState('GIRIS');
  const [itemLocations, setItemLocations] = useState({}); // { [prodId]: sourceLocationId }
  const [itemQuantities, setItemQuantities] = useState({}); // { [prodId]: '10' }

  // Transfer için ortak Hedef Depo, 3 seçenekli Hedef Raf Modu ('OWN' | 'K_BLOCK' | 'OPTIONAL') ve Opsiyonel seçimler
  const [targetWarehouse, setTargetWarehouse] = useState('DEPO-2');
  const [targetShelfMode, setTargetShelfMode] = useState('OWN');
  const [optionalTargetLocations, setOptionalTargetLocations] = useState({}); // { [prodId]: targetLocationId }

  const [txNote, setTxNote] = useState('');
  const [txSubmitting, setTxSubmitting] = useState(false);
  const [txFeedback, setTxFeedback] = useState(null);

  const isSupervisor = profile?.role === 'sorumlu';
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const locationMap = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  // Adım 1 için depo özetleri
  const warehouseSummaries = useMemo(() => {
    return WAREHOUSES.map((w) => {
      const wLocs = locations.filter((l) => l.warehouse_code === w.code);
      const normalLocIds = new Set(
        wLocs.filter((l) => !l.shelf_code.startsWith('K')).map((l) => l.id)
      );
      const kLocIds = new Set(
        wLocs.filter((l) => l.shelf_code.startsWith('K')).map((l) => l.id)
      );

      const normalStocks = stocks.filter((s) => normalLocIds.has(s.location_id));
      const kStocks = stocks.filter((s) => kLocIds.has(s.location_id));

      const totalUnits = normalStocks.reduce((acc, s) => acc + s.quantity, 0);
      const spoiledUnits = kStocks.reduce((acc, s) => acc + s.quantity, 0);

      const criticalCount = products.filter((prod) => {
        const qty = normalStocks
          .filter((s) => s.product_id === prod.id)
          .reduce((acc, s) => acc + s.quantity, 0);
        return qty <= prod.min_stock_level;
      }).length;

      return {
        ...w,
        itemCount: normalStocks.length,
        totalUnits,
        spoiledUnits,
        criticalCount,
      };
    });
  }, [locations, stocks, products]);

  // Adım 2 için seçili depodaki ürün listesi
  const warehouseProducts = useMemo(() => {
    if (!selectedWarehouse) return [];
    const wLocs = locations.filter((l) => l.warehouse_code === selectedWarehouse);
    const normalLocs = wLocs.filter((l) => !l.shelf_code.startsWith('K'));
    const kLocs = wLocs.filter((l) => l.shelf_code.startsWith('K'));
    const normalLocIds = new Set(normalLocs.map((l) => l.id));
    const kLocIds = new Set(kLocs.map((l) => l.id));

    return products
      .map((prod) => {
        const prodNormalStocks = stocks.filter(
          (s) => s.product_id === prod.id && normalLocIds.has(s.location_id)
        );
        const prodKStocks = stocks.filter(
          (s) => s.product_id === prod.id && kLocIds.has(s.location_id)
        );

        const usableQty = prodNormalStocks.reduce((acc, s) => acc + s.quantity, 0);
        const spoiledQty = prodKStocks.reduce((acc, s) => acc + s.quantity, 0);
        const primaryStock = prodNormalStocks[0];
        const primaryLoc = primaryStock
          ? locationMap.get(primaryStock.location_id)
          : normalLocs[0];

        return {
          product: prod,
          primaryLoc,
          usableQty,
          spoiledQty,
          isCritical: usableQty <= prod.min_stock_level,
        };
      })
      .sort((a, b) => a.product.sku.localeCompare(b.product.sku));
  }, [selectedWarehouse, locations, products, stocks, locationMap]);

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))),
    [products]
  );

  const filteredWarehouseProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return warehouseProducts.filter((item) => {
      if (selectedCategory !== 'ALL' && item.product.category !== selectedCategory) return false;
      if (onlyCritical && !item.isCritical) return false;
      if (q) {
        const matchSku = item.product.sku.toLowerCase().includes(q);
        const matchName = item.product.name.toLowerCase().includes(q);
        const matchBrand = item.product.brand.toLowerCase().includes(q);
        const matchShelf = item.primaryLoc?.shelf_code.toLowerCase().includes(q);
        return matchSku || matchName || matchBrand || matchShelf;
      }
      return true;
    });
  }, [warehouseProducts, selectedCategory, onlyCritical, productSearch]);

  // Verilen depo için ürünün yalnızca 2 rafını döndürür:
  // 1) Ürünün kendi normal rafı (ör. A1)
  // 2) Kategorisine göre K1-K6 bozuk/karantina rafı (ör. K1)
  function getWarehouseShelfPair(product, warehouseCode) {
    if (!product || !warehouseCode) return { ownLoc: null, kLoc: null, options: [] };

    const wLocs = locations.filter((l) => l.warehouse_code === warehouseCode);
    const normalLocs = wLocs.filter((l) => !l.shelf_code.startsWith('K'));
    const kShelfCode = getKBlockShelfForCategory(product.category);
    const kLoc = wLocs.find((l) => l.shelf_code === kShelfCode) || null;

    // 1. Önce bu depodaki normal stok kaydından ürünün kendi rafını bul
    const existingInWarehouse = stocks.find(
      (s) => s.product_id === product.id && normalLocs.some((nl) => nl.id === s.location_id)
    );
    let ownLoc = existingInWarehouse
      ? locationMap.get(existingInWarehouse.location_id) || null
      : null;

    // 2. Bu depoda kayıt yoksa diğer depolardaki normal raf kodundan eşleştir
    if (!ownLoc) {
      const anyNormalStock = stocks.find((s) => {
        if (s.product_id !== product.id) return false;
        const loc = locationMap.get(s.location_id);
        return loc && !loc.shelf_code.startsWith('K');
      });
      if (anyNormalStock) {
        const refShelfCode = locationMap.get(anyNormalStock.location_id)?.shelf_code;
        ownLoc = normalLocs.find((nl) => nl.shelf_code === refShelfCode) || null;
      }
    }

    if (!ownLoc) {
      ownLoc = normalLocs[0] || null;
    }

    const options = [];
    if (ownLoc) {
      options.push({
        loc: ownLoc,
        label: `Raf ${ownLoc.shelf_code} • Ürünün Kendi Rafı`,
      });
    }
    if (kLoc && (!ownLoc || kLoc.id !== ownLoc.id)) {
      options.push({
        loc: kLoc,
        label: `Raf ${kShelfCode} • Bozuk / Karantina`,
      });
    }

    return { ownLoc, kLoc, options };
  }

  // Hedef depo için opsiyonel hedef raf seçeneklerini döndürür
  function getAllowedTargetOptions(product, targetWCode) {
    const { ownLoc, kLoc, options } = getWarehouseShelfPair(product, targetWCode);
    if (targetWCode === selectedWarehouse) {
      return kLoc
        ? [
            {
              loc: kLoc,
              label: `Raf ${kLoc.shelf_code} • Bozuk / Karantina`,
            },
          ]
        : [];
    }
    return options;
  }

  // Aktif seçime göre ürünün gideceği nihai hedef rafı çözer
  function resolveFinalTargetLocation(product) {
    const isSameWarehouse = targetWarehouse === selectedWarehouse;
    const { ownLoc, kLoc } = getWarehouseShelfPair(product, targetWarehouse);

    if (isSameWarehouse || targetShelfMode === 'K_BLOCK') {
      return {
        loc: kLoc,
        tag: kLoc ? `Bozuk / Karantina (${kLoc.shelf_code})` : 'K Bloğu Rafı Bulunamadı',
      };
    }

    if (targetShelfMode === 'OWN') {
      return {
        loc: ownLoc,
        tag: ownLoc ? `Ürünün Kendi Rafı (${ownLoc.shelf_code})` : 'Hedef Raf Bulunamadı',
      };
    }

    // OPTIONAL (Opsiyonel mod: her ürün için ayrı seçilen raf)
    const chosenId = Number(optionalTargetLocations[product.id] || 0);
    if (kLoc && chosenId === kLoc.id) {
      return { loc: kLoc, tag: `Opsiyonel Seçim: Bozuk / Karantina (${kLoc.shelf_code})` };
    }
    if (ownLoc) {
      return { loc: ownLoc, tag: `Opsiyonel Seçim: Ürünün Kendi Rafı (${ownLoc.shelf_code})` };
    }
    return {
      loc: kLoc,
      tag: kLoc ? `Opsiyonel Seçim: Bozuk / Karantina (${kLoc.shelf_code})` : 'Hedef Raf Bulunamadı',
    };
  }

  function handleSelectWarehouse(wCode) {
    const defaultTargetW = wCode === 'DEPO-1' ? 'DEPO-2' : 'DEPO-1';
    setSelectedWarehouse(wCode);
    setSelectedProductIds([]);
    setIsStep3Active(false);
    setProductSearch('');
    setSelectedCategory('ALL');
    setOnlyCritical(false);
    setTxFeedback(null);
    setTargetWarehouse(defaultTargetW);
    setTargetShelfMode('OWN');
    setOptionalTargetLocations({});
  }

  function toggleProductSelection(prodId) {
    setSelectedProductIds((prev) =>
      prev.includes(prodId) ? prev.filter((id) => id !== prodId) : [...prev, prodId]
    );
  }

  function proceedToStep3(idsToUse) {
    const finalIds = idsToUse || selectedProductIds;
    if (finalIds.length === 0) return;

    const defaultTargetW =
      targetWarehouse && targetWarehouse !== selectedWarehouse
        ? targetWarehouse
        : selectedWarehouse === 'DEPO-1'
        ? 'DEPO-2'
        : 'DEPO-1';

    const nextLocs = { ...itemLocations };
    const nextQtys = { ...itemQuantities };
    const nextOptLocs = { ...optionalTargetLocations };

    finalIds.forEach((prodId) => {
      const prod = productMap.get(prodId);

      // Kaynak raf için yalnızca ürünün kendi rafı veya ilgili K rafı geçerli olsun
      const { options: sourceOptions } = getWarehouseShelfPair(prod, selectedWarehouse);
      const currentSourceId = Number(nextLocs[prodId] || 0);
      if (!sourceOptions.some((opt) => opt.loc.id === currentSourceId)) {
        nextLocs[prodId] = sourceOptions[0] ? String(sourceOptions[0].loc.id) : '';
      }

      if (nextQtys[prodId] === undefined || nextQtys[prodId] === '') {
        nextQtys[prodId] = '10';
      }

      const targetOptions = getAllowedTargetOptions(prod, defaultTargetW);
      const currentOpt = Number(nextOptLocs[prodId] || 0);
      if (!targetOptions.some((o) => o.loc.id === currentOpt)) {
        nextOptLocs[prodId] = targetOptions[0] ? String(targetOptions[0].loc.id) : '';
      }
    });

    setSelectedProductIds(finalIds);
    setItemLocations(nextLocs);
    setItemQuantities(nextQtys);
    setTargetWarehouse(defaultTargetW);
    setTargetShelfMode('OWN');
    setOptionalTargetLocations(nextOptLocs);
    setTxFeedback(null);
    setIsStep3Active(true);
  }

  function handleQuickSingleProduct(prodId) {
    proceedToStep3([prodId]);
  }

  function handleRemoveFromBatch(prodId) {
    const remaining = selectedProductIds.filter((id) => id !== prodId);
    setSelectedProductIds(remaining);
    if (remaining.length === 0) {
      setIsStep3Active(false);
    }
  }

  // Kaynak raf değiştiğinde çalışır
  function handleSourceLocationChange(prodId, newSourceLocId) {
    setItemLocations((prev) => ({ ...prev, [prodId]: newSourceLocId }));
  }

  // Ortak Hedef Depo değiştiğinde çalışır
  function handleCommonTargetWarehouseChange(newWarehouseCode) {
    setTargetWarehouse(newWarehouseCode);
    const isSame = newWarehouseCode === selectedWarehouse;

    if (isSame) {
      setTargetShelfMode('K_BLOCK');
    } else if (targetShelfMode === 'K_BLOCK' && selectedWarehouse === targetWarehouse) {
      setTargetShelfMode('OWN');
    }

    const nextOptLocs = {};
    selectedProductIds.forEach((prodId) => {
      const prod = productMap.get(prodId);
      const options = getAllowedTargetOptions(prod, newWarehouseCode);
      nextOptLocs[prodId] = options[0] ? String(options[0].loc.id) : '';
    });
    setOptionalTargetLocations(nextOptLocs);
  }

  // Ortak Hedef Raf Seçimi (1. Kendi Rafı / 2. İlgili K Rafı / 3. Opsiyonel) değiştiğinde çalışır
  function handleCommonShelfModeChange(newMode) {
    setTargetShelfMode(newMode);
    if (newMode === 'OPTIONAL') {
      const nextOptLocs = { ...optionalTargetLocations };
      selectedProductIds.forEach((prodId) => {
        const prod = productMap.get(prodId);
        const options = getAllowedTargetOptions(prod, targetWarehouse);
        const existingId = Number(nextOptLocs[prodId] || 0);
        if (!options.some((o) => o.loc.id === existingId)) {
          nextOptLocs[prodId] = options[0] ? String(options[0].loc.id) : '';
        }
      });
      setOptionalTargetLocations(nextOptLocs);
    }
  }

  async function handleExecuteBatch(e) {
    e.preventDefault();
    if (txSubmitting || selectedAction === 'SORGULAMA') return;

    setTxFeedback(null);

    // 1. Ön Doğrulama (Tüm seçili ürünler için)
    const batchItems = [];
    for (const prodId of selectedProductIds) {
      const product = productMap.get(prodId);
      const sourceLocId = Number(itemLocations[prodId]);
      const sourceLoc = locationMap.get(sourceLocId);
      const qty = Number(itemQuantities[prodId]);

      if (!product || !sourceLoc) {
        setTxFeedback({
          type: 'error',
          messages: ['Seçili ürünlerden biri için geçerli kaynak raf konumu bulunamadı.'],
        });
        return;
      }

      if (Number.isNaN(qty) || (selectedAction === 'SAYIM' ? qty < 0 : qty <= 0)) {
        setTxFeedback({
          type: 'error',
          messages: [`[${product.sku}] ${product.name} için geçerli bir miktar giriniz.`],
        });
        return;
      }

      const currentStockRow = stocks.find(
        (s) => s.product_id === prodId && s.location_id === sourceLocId
      );
      const currentQty = currentStockRow ? currentStockRow.quantity : 0;

      if ((selectedAction === 'CIKIS' || selectedAction === 'TRANSFER') && qty > currentQty) {
        setTxFeedback({
          type: 'error',
          messages: [
            `Yetersiz stok: [${product.sku}] ${product.name} (${sourceLoc.shelf_code} rafında mevcut: ${currentQty}, istenen: ${qty}).`,
          ],
        });
        return;
      }

      let targetLocId = null;
      if (selectedAction === 'GIRIS') {
        targetLocId = sourceLocId;
      } else if (selectedAction === 'TRANSFER') {
        const resolved = resolveFinalTargetLocation(product);
        if (!resolved.loc) {
          const expectedK = getKBlockShelfForCategory(product.category);
          setTxFeedback({
            type: 'error',
            messages: [
              `[${product.sku}] ${product.name} için hedef raf bulunamadı. Hedef depoda ${expectedK} rafının veritabanında tanımlı olduğundan emin olun.`,
            ],
          });
          return;
        }
        if (resolved.loc.id === sourceLocId) {
          setTxFeedback({
            type: 'error',
            messages: [
              `[${product.sku}] için kaynak raf ile hedef raf (${sourceLoc.warehouse_name} - ${sourceLoc.shelf_code}) aynı olamaz.`,
            ],
          });
          return;
        }
        targetLocId = resolved.loc.id;
      }

      batchItems.push({
        product,
        sourceLoc,
        targetLocId,
        qty,
      });
    }

    // 2. Veritabanı İşlemlerini Sırayla Uygula
    setTxSubmitting(true);
    const resultMessages = [];
    let hasError = false;

    for (const item of batchItems) {
      const payload = {
        p_tx_type: selectedAction,
        p_product_id: item.product.id,
        p_source_location_id:
          selectedAction === 'CIKIS' || selectedAction === 'TRANSFER' || selectedAction === 'SAYIM'
            ? item.sourceLoc.id
            : null,
        p_target_location_id:
          selectedAction === 'GIRIS' || selectedAction === 'TRANSFER' ? item.targetLocId : null,
        p_quantity: item.qty,
        p_note: txNote.trim() || null,
        p_idempotency_key: generateIdempotencyKey(),
      };

      const { data, error } = await supabase.rpc('execute_stock_movement', payload);

      if (error) {
        hasError = true;
        resultMessages.push(`HATA [${item.product.sku}]: ${error.message}`);
      } else {
        const targetLocObj = item.targetLocId ? locationMap.get(item.targetLocId) : null;
        const targetInfo =
          selectedAction === 'TRANSFER' && targetLocObj
            ? ` → Hedef: ${targetLocObj.warehouse_name} (Raf: ${targetLocObj.shelf_code})`
            : '';
        resultMessages.push(
          `OK [${item.product.sku}] ${item.product.name}: ${data.previous_qty} → ${data.new_qty}${targetInfo}`
        );
      }
    }

    setTxFeedback({
      type: hasError ? 'error' : 'success',
      messages: resultMessages,
    });

    if (!hasError) {
      setTxNote('');
    }
    await onReloadData(session.user.id);
    setTxSubmitting(false);
  }

  const selectedWarehouseObj = WAREHOUSES.find((w) => w.code === selectedWarehouse);
  const targetWarehouseObj = WAREHOUSES.find((w) => w.code === targetWarehouse);
  const isSameWarehouseTransfer = targetWarehouse === selectedWarehouse;

  const selectedProductsList = useMemo(
    () => selectedProductIds.map((id) => productMap.get(id)).filter(Boolean),
    [selectedProductIds, productMap]
  );

  return (
    <div className="space-y-5">
      {/* Depo Sorumlusu için Ana Menüye Dönüş Çubuğu */}
      {isSupervisor && onBackToMenu && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onBackToMenu}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 shadow-sm"
          >
            ← Sorumlu Ana Menüsüne Dön (İşlem Yap / Raporlar)
          </button>
        </div>
      )}

      {/* ADIM GÖSTERGESİ */}
      <div className="grid grid-cols-3 gap-2 bg-white p-2 rounded-xl shadow-sm border border-slate-200 text-xs sm:text-sm">
        <button
          type="button"
          onClick={() => {
            setSelectedWarehouse('');
            setSelectedProductIds([]);
            setIsStep3Active(false);
            setTxFeedback(null);
          }}
          className={`py-2 px-3 rounded-lg font-semibold text-left transition ${
            !selectedWarehouse
              ? 'bg-blue-600 text-white'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          <div className="text-[11px] opacity-80">1. Adım</div>
          <div className="truncate">
            {selectedWarehouseObj ? selectedWarehouseObj.name : 'Depo Seçimi'}
          </div>
        </button>

        <button
          type="button"
          disabled={!selectedWarehouse}
          onClick={() => {
            setIsStep3Active(false);
            setTxFeedback(null);
          }}
          className={`py-2 px-3 rounded-lg font-semibold text-left transition ${
            selectedWarehouse && !isStep3Active
              ? 'bg-blue-600 text-white'
              : selectedWarehouse
              ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              : 'bg-slate-50 text-slate-400 cursor-not-allowed'
          }`}
        >
          <div className="text-[11px] opacity-80">2. Adım</div>
          <div className="truncate">
            {selectedProductIds.length > 0
              ? `Ürün Seçimi (${selectedProductIds.length} Seçili)`
              : 'Çoklu Ürün Seçimi'}
          </div>
        </button>

        <div
          className={`py-2 px-3 rounded-lg font-semibold text-left ${
            selectedWarehouse && isStep3Active
              ? 'bg-blue-600 text-white'
              : 'bg-slate-50 text-slate-400'
          }`}
        >
          <div className="text-[11px] opacity-80">3. Adım</div>
          <div className="truncate">İşlem Seçimi</div>
        </div>
      </div>

      {/* ============================================================
          ADIM 1: DEPO SEÇİMİ EKRANI
         ============================================================ */}
      {!selectedWarehouse && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-200">
            <h2 className="text-lg font-bold text-slate-900">1. İşlem Yapılacak Depoyu Seçin</h2>
            <p className="text-sm text-slate-500 mt-1">
              Stok işlemi veya sorgulama yapmak istediğiniz depo şubesine dokunun.
            </p>
          </div>

          {dataLoading ? (
            <div className="bg-white rounded-xl p-8 text-center text-sm text-slate-500 border border-slate-200">
              Depo verileri yükleniyor...
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {warehouseSummaries.map((w) => (
                <button
                  key={w.code}
                  type="button"
                  onClick={() => handleSelectWarehouse(w.code)}
                  className="text-left bg-white hover:border-blue-600 hover:shadow-md rounded-2xl p-5 shadow-sm border-2 border-slate-200 transition flex flex-col justify-between space-y-4"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="px-2.5 py-1 text-xs font-mono font-bold bg-slate-100 text-slate-700 rounded">
                        {w.code}
                      </span>
                      {w.criticalCount > 0 ? (
                        <span className="px-2.5 py-1 text-xs font-semibold bg-red-100 text-red-700 rounded-full">
                          {w.criticalCount} Kritik Ürün
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 text-xs font-semibold bg-emerald-100 text-emerald-700 rounded-full">
                          Stoklar Normal
                        </span>
                      )}
                    </div>

                    <h3 className="text-xl font-bold text-slate-900 mt-3">{w.name}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">{w.district}</p>
                  </div>

                  <div className="pt-3 border-t border-slate-100 space-y-1 text-xs text-slate-600">
                    <div className="flex items-center justify-between">
                      <span>{w.itemCount} Kalem Ürün</span>
                      <span className="font-bold text-slate-900">
                        {w.totalUnits.toLocaleString('tr-TR')} Birim
                      </span>
                    </div>
                    {w.spoiledUnits > 0 && (
                      <div className="flex items-center justify-between text-amber-700 font-medium">
                        <span>K Bloğu (Bozuk/Karantina)</span>
                        <span>{w.spoiledUnits} Birim</span>
                      </div>
                    )}
                  </div>

                  <div className="w-full py-2 text-center rounded-lg bg-blue-50 text-blue-700 font-semibold text-sm">
                    Bu Depoyu Seç →
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ============================================================
          ADIM 2: ÇOKLU ÜRÜN SEÇME EKRANI
         ============================================================ */}
      {selectedWarehouse && !isStep3Active && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-200 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold uppercase text-blue-700">
                  Seçili Depo: {selectedWarehouseObj?.name} ({selectedWarehouse})
                </span>
                <h2 className="text-lg font-bold text-slate-900 mt-0.5">
                  2. İşlem Yapılacak Ürünleri Seçin (Tekli veya Çoklu)
                </h2>
                <p className="text-xs text-slate-500">
                  Birden fazla ürün seçerek tek seferde toplu giriş, çıkış, transfer veya sayım yapabilirsiniz.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedWarehouse('')}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                ← Depo Değiştir
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input
                type="text"
                autoFocus
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Ürün kodu (KHV001) veya ürün adı / marka / raf ara..."
                className="sm:col-span-2 rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
              />

              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm bg-white focus:border-blue-600 focus:outline-none"
              >
                <option value="ALL">Tüm Kategoriler</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setOnlyCritical((prev) => !prev)}
                className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition ${
                  onlyCritical
                    ? 'bg-red-600 text-white border-red-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {onlyCritical ? 'Kritik Filtre: Açık' : 'Sadece Kritik Stoklar'}
              </button>
            </div>
          </div>

          {selectedProductIds.length > 0 && (
            <div className="sticky top-16 z-10 bg-slate-900 text-white rounded-xl p-4 shadow-lg flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold">{selectedProductIds.length} Ürün Seçildi</div>
                <div className="text-xs text-slate-300 truncate max-w-md">
                  {selectedProductsList.map((p) => `${p.sku} (${p.name})`).join(', ')}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedProductIds([])}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold"
                >
                  Seçimi Temizle
                </button>
                <button
                  type="button"
                  onClick={() => proceedToStep3()}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs sm:text-sm font-bold"
                >
                  Seçili {selectedProductIds.length} Ürünle İşleme Geç →
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            {filteredWarehouseProducts.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Arama kriterine uygun ürün bulunamadı.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredWarehouseProducts.map((item) => {
                  const isChecked = selectedProductIds.includes(item.product.id);
                  const kShelf = getKBlockShelfForCategory(item.product.category);
                  return (
                    <div
                      key={item.product.id}
                      onClick={() => toggleProductSelection(item.product.id)}
                      className={`p-4 flex flex-wrap items-center justify-between gap-3 cursor-pointer transition ${
                        isChecked
                          ? 'bg-blue-50/80'
                          : item.isCritical
                          ? 'bg-red-50/60 hover:bg-red-50'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="mt-1 h-5 w-5 rounded border-slate-300 text-blue-600 cursor-pointer"
                        />

                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="px-2 py-0.5 text-xs font-mono font-bold bg-slate-900 text-white rounded">
                              {item.product.sku}
                            </span>
                            <span className="px-2 py-0.5 text-xs font-mono font-semibold bg-slate-200 text-slate-800 rounded">
                              Raf: {item.primaryLoc?.shelf_code || '-'}
                            </span>
                            <span className="px-2 py-0.5 text-xs font-mono bg-amber-100 text-amber-800 rounded">
                              Bozuk Rafı: {kShelf}
                            </span>
                            {item.isCritical && (
                              <span className="px-2 py-0.5 text-xs font-semibold bg-red-100 text-red-700 rounded-full">
                                Kritik Eşik (≤ {item.product.min_stock_level})
                              </span>
                            )}
                            {item.spoiledQty > 0 && (
                              <span className="px-2 py-0.5 text-xs font-semibold bg-purple-100 text-purple-800 rounded-full">
                                {kShelf} Stok: {item.spoiledQty}
                              </span>
                            )}
                          </div>
                          <div className="font-bold text-slate-900 text-sm sm:text-base">
                            {item.product.name}
                          </div>
                          <div className="text-xs text-slate-500">
                            {item.product.brand} • {item.product.category} • {item.product.unit} (
                            {item.product.pack_detail})
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 ml-auto">
                        <div className="text-right">
                          <div className="text-xs text-slate-500">Mevcut Stok</div>
                          <div className="text-lg font-bold text-slate-900">
                            {item.usableQty}{' '}
                            <span className="text-xs font-normal text-slate-600">
                              {item.product.unit}
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickSingleProduct(item.product.id);
                          }}
                          className="px-3 py-2 rounded-lg border border-blue-600 text-blue-700 hover:bg-blue-600 hover:text-white text-xs font-semibold transition"
                        >
                          Tek Seç →
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================
          ADIM 3: YAPILACAK İŞLEMİ SEÇME VE TOPLU UYGULAMA
         ============================================================ */}
      {selectedWarehouse && isStep3Active && selectedProductsList.length > 0 && (
        <div className="space-y-4">
          {/* Üst Özet Çubuğu */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-1 text-xs font-semibold bg-blue-100 text-blue-800 rounded-lg">
                  {selectedWarehouseObj?.name}
                </span>
                <span className="px-2.5 py-1 text-xs font-bold bg-slate-900 text-white rounded-lg">
                  {selectedProductsList.length} Ürün Seçili
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1.5">
                {selectedProductsList.map((p) => `${p.sku} (${p.name})`).join(' • ')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsStep3Active(false);
                  setTxFeedback(null);
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                ← Ürün Ekle / Çıkar
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedWarehouse('');
                  setSelectedProductIds([]);
                  setIsStep3Active(false);
                  setTxFeedback(null);
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                Depo Değiştir
              </button>
            </div>
          </div>

          {/* 5 İŞLEM SEÇENEĞİ */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-slate-200 space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">3. Yapılacak İşlemi Seçin</h3>
              <p className="text-xs text-slate-500">
                Seçili {selectedProductsList.length} ürün için uygulanacak işlemi belirleyin.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { id: 'GIRIS', label: 'Stok Girişi', disabled: false },
                { id: 'CIKIS', label: 'Stok Çıkışı', disabled: false },
                { id: 'TRANSFER', label: 'Depo / Raf Transferi', disabled: false },
                {
                  id: 'SAYIM',
                  label: isSupervisor ? 'Sayım - Düzeltme' : 'Sayım (Sorumlu)',
                  disabled: !isSupervisor,
                },
                { id: 'SORGULAMA', label: 'Stok Sorgulama', disabled: false },
              ].map((act) => (
                <button
                  key={act.id}
                  type="button"
                  disabled={act.disabled}
                  onClick={() => {
                    setTxFeedback(null);
                    setSelectedAction(act.id);
                  }}
                  className={`py-3 px-2.5 rounded-xl text-xs font-bold border-2 transition text-center ${
                    selectedAction === act.id
                      ? 'bg-blue-600 text-white border-blue-700 shadow-sm'
                      : act.disabled
                      ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-blue-400'
                  }`}
                >
                  {act.label}
                </button>
              ))}
            </div>

            {!isSupervisor && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Not: <strong>Depo Personeli</strong> rolüyle giriş yaptığınız için{' '}
                <strong>Sayım - Düzeltme</strong> yetkisi yalnızca Depo Sorumlusuna açıktır.
              </p>
            )}

            {/* SEÇİLEN İŞLEM: STOK SORGULAMA */}
            {selectedAction === 'SORGULAMA' ? (
              <div className="space-y-6 pt-2">
                {selectedProductsList.map((prod) => {
                  const statusRows = WAREHOUSES.map((w) => {
                    const wLocs = locations.filter((l) => l.warehouse_code === w.code);
                    const wLocIds = new Set(wLocs.map((l) => l.id));
                    const matching = stocks.filter(
                      (s) => s.product_id === prod.id && wLocIds.has(s.location_id)
                    );
                    const totalQty = matching.reduce((acc, s) => acc + s.quantity, 0);
                    const shelfText =
                      matching.length > 0
                        ? matching
                            .map(
                              (s) =>
                                `${locationMap.get(s.location_id)?.shelf_code} (${s.quantity})`
                            )
                            .join(', ')
                        : wLocs[0]?.shelf_code || '-';
                    return {
                      warehouse: w,
                      shelfText,
                      totalQty,
                      isCritical: totalQty <= prod.min_stock_level,
                    };
                  });

                  const prodTxs = transactions.filter((t) => t.product_id === prod.id).slice(0, 10);

                  return (
                    <div
                      key={prod.id}
                      className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="px-2 py-0.5 text-xs font-mono font-bold bg-slate-900 text-white rounded mr-2">
                            {prod.sku}
                          </span>
                          <span className="font-bold text-slate-900">{prod.name}</span>
                        </div>
                        <span className="text-xs text-slate-500">
                          {prod.brand} • {prod.category} • Kritik Eşik: {prod.min_stock_level}{' '}
                          {prod.unit}
                        </span>
                      </div>

                      <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200 uppercase text-slate-500">
                              <th className="py-2 px-3">Depo</th>
                              <th className="py-2 px-3">Raflar (Miktar)</th>
                              <th className="py-2 px-3 text-right">Toplam Stok</th>
                              <th className="py-2 px-3 text-center">Durum</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {statusRows.map((r) => (
                              <tr key={r.warehouse.code}>
                                <td className="py-2 px-3 font-semibold">{r.warehouse.name}</td>
                                <td className="py-2 px-3 font-mono">{r.shelfText}</td>
                                <td className="py-2 px-3 text-right font-bold">
                                  {r.totalQty} {prod.unit}
                                </td>
                                <td className="py-2 px-3 text-center">
                                  {r.isCritical ? (
                                    <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                                      Kritik
                                    </span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">
                                      Normal
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {prodTxs.length > 0 && (
                        <div className="text-xs text-slate-600">
                          <span className="font-semibold">Son İşlem: </span>
                          {TX_LABELS[prodTxs[0].tx_type]?.label || prodTxs[0].tx_type} (
                          {prodTxs[0].previous_qty} → {prodTxs[0].new_qty}) •{' '}
                          {new Date(prodTxs[0].created_at).toLocaleString('tr-TR')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* SEÇİLEN İŞLEM: TOPLU GİRİŞ, ÇIKIŞ, TRANSFER VEYA SAYIM */
              <form onSubmit={handleExecuteBatch} className="space-y-4 pt-2">
                {/* ORTAK HEDEF DEPO VE 3 SEÇENEKLİ HEDEF RAF SEÇİM KUTUSU */}
                {selectedAction === 'TRANSFER' && (
                  <div className="p-4 rounded-xl bg-blue-50/80 border border-blue-200 space-y-3">
                    <div className="text-xs font-bold uppercase text-blue-900">
                      Ortak Transfer Adresi (Hedef Depo & Hedef Raf Seçimi)
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* 1. KUTU: ORTAK HEDEF DEPO */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          1. Hedef Depo (Tüm Seçili Ürünler İçin Ortak)
                        </label>
                        <select
                          value={targetWarehouse}
                          onChange={(e) => handleCommonTargetWarehouseChange(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm bg-white font-semibold"
                        >
                          {WAREHOUSES.map((w) => (
                            <option key={w.code} value={w.code}>
                              {w.name} {w.code === selectedWarehouse ? '(Mevcut Depo)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 2. KUTU: 3 SEÇENEKLİ HEDEF RAF SEÇİMİ */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          2. Hedef Raf Seçimi
                        </label>
                        <select
                          value={isSameWarehouseTransfer ? 'K_BLOCK' : targetShelfMode}
                          onChange={(e) => handleCommonShelfModeChange(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm bg-white font-semibold"
                        >
                          <option value="OWN" disabled={isSameWarehouseTransfer}>
                            1. Hepsini Kendi Rafına
                          </option>
                          <option value="K_BLOCK">
                            2. Hepsini İlgili K Rafına (Bozuk / Karantina)
                          </option>
                          <option value="OPTIONAL" disabled={isSameWarehouseTransfer}>
                            3. Opsiyonel (Ürün Bazlı Ayrı Raf Seç)
                          </option>
                        </select>
                      </div>
                    </div>

                    {isSameWarehouseTransfer ? (
                      <p className="text-xs text-amber-800 bg-amber-100/80 border border-amber-200 rounded-lg px-3 py-2">
                        Aynı depo içinde transfer seçildiği için tüm ürünler otomatik olarak kendi
                        kategorilerine ait <strong>K1–K6</strong> bozuk/karantina raflarına gider.
                      </p>
                    ) : targetShelfMode === 'OPTIONAL' ? (
                      <p className="text-xs text-blue-900 bg-white border border-blue-200 rounded-lg px-3 py-2">
                        <strong>Opsiyonel Seçim Aktif:</strong> Aşağıda alt alta sıralanan her ürün
                        için kendi rafını (ör. <code>A1</code>) veya K bloğundaki rafını (ör.{' '}
                        <code>K1</code>) ayrı ayrı seçebilirsiniz.
                      </p>
                    ) : null}
                  </div>
                )}

                {/* SEÇİLİ ÜRÜNLER VE HER BİRİ İÇİN KAYNAK RAF (2 SEÇENEK), MİKTAR VE (OPSİYONELSE) HEDEF RAF */}
                <div className="space-y-3">
                  <div className="text-xs font-bold uppercase text-slate-600">
                    Seçili Ürünler ve Miktar Girişi ({selectedProductsList.length} Ürün)
                  </div>

                  {selectedProductsList.map((prod) => {
                    const { options: sourceShelfOptions } = getWarehouseShelfPair(
                      prod,
                      selectedWarehouse
                    );
                    const activeLocId = Number(
                      itemLocations[prod.id] ||
                        (sourceShelfOptions[0] ? sourceShelfOptions[0].loc.id : 0)
                    );
                    const currentStockRow = stocks.find(
                      (s) => s.product_id === prod.id && s.location_id === activeLocId
                    );
                    const currentQty = currentStockRow ? currentStockRow.quantity : 0;

                    const optionalTwoChoices = getAllowedTargetOptions(prod, targetWarehouse);
                    const resolvedTarget =
                      selectedAction === 'TRANSFER' ? resolveFinalTargetLocation(prod) : null;

                    const targetExistingQty = resolvedTarget?.loc
                      ? stocks.find(
                          (s) =>
                            s.product_id === prod.id &&
                            s.location_id === resolvedTarget.loc.id
                        )?.quantity || 0
                      : 0;

                    return (
                      <div
                        key={prod.id}
                        className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="px-2 py-0.5 text-xs font-mono font-bold bg-slate-900 text-white rounded">
                                {prod.sku}
                              </span>
                              <span className="font-bold text-slate-900 text-sm">{prod.name}</span>
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              {prod.brand} • {prod.category} • Seçili Raftaki Mevcut Stok:{' '}
                              <strong className="text-blue-700">
                                {currentQty} {prod.unit}
                              </strong>
                            </div>
                          </div>

                          {selectedProductsList.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveFromBatch(prod.id)}
                              className="text-xs text-red-600 hover:text-red-800 font-semibold"
                            >
                              Listeden Çıkar ✕
                            </button>
                          )}
                        </div>

                        {/* Kaynak Raf (Yalnızca Kendi Rafı ve İlgili K Rafı) ve İşlem Miktarı */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-600 mb-1">
                              {selectedAction === 'GIRIS'
                                ? `${selectedWarehouseObj?.name} • Hedef Raf (2 Seçenek)`
                                : `${selectedWarehouseObj?.name} • Kaynak Raf (2 Seçenek)`}
                            </label>
                            <select
                              value={activeLocId || ''}
                              onChange={(e) =>
                                handleSourceLocationChange(prod.id, e.target.value)
                              }
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white font-medium"
                            >
                              {sourceShelfOptions.map((opt) => {
                                const shelfStock =
                                  stocks.find(
                                    (s) =>
                                      s.product_id === prod.id && s.location_id === opt.loc.id
                                  )?.quantity || 0;
                                return (
                                  <option key={opt.loc.id} value={opt.loc.id}>
                                    {opt.label} (Mevcut: {shelfStock} {prod.unit})
                                  </option>
                                );
                              })}
                            </select>
                          </div>

                          <div>
                            <label className="block text-xs font-semibold text-slate-600 mb-1">
                              {selectedAction === 'SAYIM'
                                ? `Yeni Sayım Miktarı (${prod.unit})`
                                : `İşlem Miktarı (${prod.unit})`}
                            </label>
                            <input
                              type="number"
                              min={selectedAction === 'SAYIM' ? '0' : '1'}
                              required
                              value={itemQuantities[prod.id] ?? ''}
                              onChange={(e) =>
                                setItemQuantities((prev) => ({
                                  ...prev,
                                  [prod.id]: e.target.value,
                                }))
                              }
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white font-semibold"
                            />
                          </div>
                        </div>

                        {/* TRANSFER HEDEF RAF GÖSTERİMİ VEYA OPSİYONEL 2 SEÇENEKLİ KUTU */}
                        {selectedAction === 'TRANSFER' && (
                          <>
                            {!isSameWarehouseTransfer && targetShelfMode === 'OPTIONAL' ? (
                              <div className="p-3 rounded-lg bg-white border border-blue-300 space-y-1.5">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <label className="text-xs font-bold text-blue-900">
                                    {targetWarehouseObj?.name} • Hedef Raf Seçin (2 Seçenek)
                                  </label>
                                  <span className="text-xs text-slate-600">
                                    Seçili Raftaki Mevcut Stok:{' '}
                                    <strong className="text-emerald-700">
                                      {targetExistingQty} {prod.unit}
                                    </strong>
                                  </span>
                                </div>

                                <select
                                  value={
                                    optionalTargetLocations[prod.id] ||
                                    (optionalTwoChoices[0]
                                      ? String(optionalTwoChoices[0].loc.id)
                                      : '')
                                  }
                                  onChange={(e) =>
                                    setOptionalTargetLocations((prev) => ({
                                      ...prev,
                                      [prod.id]: e.target.value,
                                    }))
                                  }
                                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white font-semibold"
                                >
                                  {optionalTwoChoices.map((opt) => {
                                    const shelfStock =
                                      stocks.find(
                                        (s) =>
                                          s.product_id === prod.id &&
                                          s.location_id === opt.loc.id
                                      )?.quantity || 0;
                                    return (
                                      <option key={opt.loc.id} value={opt.loc.id}>
                                        {opt.label} (Mevcut: {shelfStock} {prod.unit})
                                      </option>
                                    );
                                  })}
                                </select>
                              </div>
                            ) : (
                              <div className="text-xs px-3 py-2 rounded-lg bg-white border border-blue-200 text-slate-700 flex flex-wrap items-center justify-between gap-2">
                                <span>
                                  <strong>Hedef Konum:</strong> {targetWarehouseObj?.name} •{' '}
                                  <span className="font-mono font-bold text-blue-700">
                                    {resolvedTarget?.tag}
                                  </span>
                                </span>
                                <span>
                                  Hedefteki Mevcut Stok:{' '}
                                  <strong className="text-emerald-700">
                                    {targetExistingQty} {prod.unit}
                                  </strong>
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Ortak Açıklama / İrsaliye Notu */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Ortak Açıklama / İrsaliye Notu
                  </label>
                  <input
                    type="text"
                    value={txNote}
                    onChange={(e) => setTxNote(e.target.value)}
                    placeholder="Örn: Haftalık mal kabul / Bozuk ürün karantina aktarımı"
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
                  />
                </div>

                {txFeedback && (
                  <div
                    className={`p-3.5 rounded-lg border text-xs sm:text-sm space-y-1 ${
                      txFeedback.type === 'success'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : 'bg-red-50 border-red-300 text-red-800'
                    }`}
                  >
                    {txFeedback.messages.map((msg, idx) => (
                      <div key={idx} className="font-medium">
                        {msg}
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={txSubmitting}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-bold py-3 rounded-xl transition"
                >
                  {txSubmitting
                    ? 'Toplu İşlem Kaydediliyor...'
                    : selectedProductsList.length > 1
                    ? `Toplu İşlemi Onayla ve Kaydet (${selectedProductsList.length} Ürün)`
                    : 'İşlemi Onayla ve Kaydet'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}