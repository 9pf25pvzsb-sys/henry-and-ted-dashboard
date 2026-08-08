/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
/* ---- Xero P&L report parser (maps a ProfitAndLoss report to the 4 figures) ----
   Revenue = trading Income section (Other Income excluded); COGS = Cost of Sales
   section; within Operating Expenses, wage/super accounts -> wagesSuper, the rest
   -> overheads. All ex-GST (Xero P&L accounts are GST-exclusive). */
const XERO_WAGE_RE = /payroll|wage|salar|kiwisaver|superannuat|\bsuper\b/i;
function xeroNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}
function xeroLastCell(cells) {
  if (!Array.isArray(cells) || !cells.length) return 0;
  return xeroNum(cells[cells.length - 1].Value);
}
function xeroAccountName(cells) {
  return (Array.isArray(cells) && cells[0] && cells[0].Value) || '';
}
function parseXeroPnl(report) {
  const rows = (report && report.Reports && report.Reports[0] && report.Reports[0].Rows) || [];
  let revenue = 0, cogs = 0, wagesSuper = 0, overheads = 0;
  for (const sec of rows) {
    if (sec.RowType !== 'Section') continue;
    const title = (sec.Title || '').toLowerCase();
    const isOther = title.indexOf('other income') >= 0;
    const isCogs = title.indexOf('cost of sales') >= 0 || title.indexOf('cost of goods') >= 0;
    const isIncome = !isOther && !isCogs &&
      (title.indexOf('income') >= 0 || title.indexOf('revenue') >= 0 ||
       title.indexOf('sales') >= 0 || title.indexOf('turnover') >= 0);
    const isOpex = !isCogs && !isIncome && !isOther &&
      (title.indexOf('expense') >= 0 || title.indexOf('overhead') >= 0 ||
       title.indexOf('administrative') >= 0);
    const secRows = sec.Rows || [];
    for (const r of secRows) {
      if (r.RowType !== 'Row') continue; /* skip SummaryRow to avoid double-count */
      const name = xeroAccountName(r.Cells);
      const val = xeroLastCell(r.Cells);
      if (isCogs) cogs += val;
      else if (isIncome) revenue += val;
      else if (isOpex) { if (XERO_WAGE_RE.test(name)) wagesSuper += val; else overheads += val; }
    }
  }
  return { revenue: revenue, cogs: cogs, wagesSuper: wagesSuper, overheads: overheads };
}

const HISTORY = [{"date":"2023-05-14","sf":16472.56,"sb":10507.87,"sd":0,"so":0,"st":26980.43,"cf":0,"cb":0,"lb":12790.78,"tx":1671},{"date":"2023-05-21","sf":16611.6,"sb":11956.03,"sd":0,"so":0,"st":28567.63,"cf":0,"cb":0,"lb":10396.42,"tx":1567},{"date":"2023-05-28","sf":14399.34,"sb":10913.2,"sd":0,"so":0,"st":25312.54,"cf":0,"cb":0,"lb":9505.32,"tx":1655},{"date":"2023-06-04","sf":15148.13,"sb":11647.04,"sd":0,"so":0,"st":26795.17,"cf":0,"cb":0,"lb":11384.1,"tx":1626},{"date":"2023-06-11","sf":15539.42,"sb":11553.92,"sd":0,"so":0,"st":27093.34,"cf":5953.97,"cb":2677.75,"lb":13432.73,"tx":1645},{"date":"2023-06-18","sf":15007.92,"sb":10998.27,"sd":0,"so":0,"st":26006.19,"cf":6952.16,"cb":3723.48,"lb":11746.78,"tx":1592},{"date":"2023-06-25","sf":15177.6,"sb":11668.51,"sd":0,"so":0,"st":26846.11,"cf":4973.73,"cb":3124.02,"lb":10603.09,"tx":null},{"date":"2023-07-23","sf":20358.32,"sb":14242.1,"sd":0,"so":0,"st":34600.42,"cf":7606.7,"cb":3282.74,"lb":13021.62,"tx":1828},{"date":"2023-07-30","sf":15129.42,"sb":12016.38,"sd":0,"so":0,"st":27145.8,"cf":0,"cb":0,"lb":0,"tx":1674},{"date":"2023-08-06","sf":15348.82,"sb":11639.13,"sd":0,"so":0,"st":26987.95,"cf":5763.71,"cb":2955.19,"lb":11741.88,"tx":1611},{"date":"2023-08-13","sf":14520.47,"sb":11441.75,"sd":0,"so":0,"st":25962.22,"cf":5820.9,"cb":3419.62,"lb":10532.46,"tx":1609},{"date":"2023-08-20","sf":16353.94,"sb":12502.37,"sd":0,"so":0,"st":28856.31,"cf":4425.05,"cb":3856.56,"lb":9985.3,"tx":1683},{"date":"2023-08-27","sf":15177.5,"sb":11072.09,"sd":0,"so":0,"st":26249.59,"cf":5967.86,"cb":3711.48,"lb":10562.57,"tx":1555},{"date":"2023-09-03","sf":16956.25,"sb":12162.17,"sd":0,"so":0,"st":29118.42,"cf":6680.83,"cb":3481.48,"lb":0,"tx":1626},{"date":"2023-09-10","sf":17135.18,"sb":12123.66,"sd":0,"so":0,"st":29258.84,"cf":0,"cb":0,"lb":12100.15,"tx":1626},{"date":"2023-09-17","sf":17744.8,"sb":13100.57,"sd":0,"so":0,"st":30845.37,"cf":5772.63,"cb":1330.8,"lb":10663.27,"tx":1666},{"date":"2023-09-24","sf":15446.44,"sb":12411.17,"sd":0,"so":0,"st":27857.61,"cf":4317.99,"cb":3303.58,"lb":11158.09,"tx":1589},{"date":"2023-10-01","sf":13797.42,"sb":12464.53,"sd":0,"so":0,"st":26261.95,"cf":4992.88,"cb":3830.83,"lb":10955.06,"tx":1586},{"date":"2023-10-08","sf":15738.55,"sb":11632.76,"sd":0,"so":0,"st":27371.31,"cf":4750.52,"cb":2336.8,"lb":12831.65,"tx":1488},{"date":"2023-10-15","sf":17817.67,"sb":13196.86,"sd":0,"so":0,"st":31014.53,"cf":5796.62,"cb":2503.58,"lb":11889.66,"tx":1666},{"date":"2023-10-22","sf":16569.45,"sb":12634.98,"sd":0,"so":0,"st":29204.43,"cf":7020.56,"cb":3861.95,"lb":12069.04,"tx":1621},{"date":"2023-10-29","sf":16611.86,"sb":13027.89,"sd":0,"so":0,"st":29639.75,"cf":5211.33,"cb":3551.73,"lb":12105.02,"tx":1621},{"date":"2023-11-05","sf":17497.02,"sb":12334.88,"sd":0,"so":0,"st":29831.9,"cf":5556.5,"cb":4253.64,"lb":12894.42,"tx":1525},{"date":"2023-11-12","sf":14586.16,"sb":11117.32,"sd":0,"so":0,"st":25703.48,"cf":4449.64,"cb":1685.16,"lb":11480.17,"tx":1444},{"date":"2023-11-19","sf":15540.84,"sb":13316.01,"sd":0,"so":0,"st":28856.85,"cf":5462.31,"cb":3300.89,"lb":11324.16,"tx":1648},{"date":"2023-11-26","sf":16839.38,"sb":14786.65,"sd":0,"so":0,"st":31626.03,"cf":5678.16,"cb":3467.47,"lb":13844.27,"tx":1590},{"date":"2023-12-03","sf":15811.33,"sb":12340.13,"sd":0,"so":0,"st":28151.46,"cf":4623.09,"cb":3903.89,"lb":12250.8,"tx":1515},{"date":"2023-12-10","sf":17394.54,"sb":11621.86,"sd":0,"so":0,"st":29016.4,"cf":6434.28,"cb":3563.48,"lb":12565.69,"tx":1574},{"date":"2023-12-17","sf":16360.21,"sb":14021.96,"sd":0,"so":0,"st":30382.17,"cf":5688.39,"cb":5486.19,"lb":11951.44,"tx":1558},{"date":"2023-12-24","sf":15061.07,"sb":13744.69,"sd":0,"so":0,"st":28805.76,"cf":6188.56,"cb":4588.58,"lb":11571.65,"tx":1447},{"date":"2023-12-31","sf":25185.73,"sb":18178.03,"sd":0,"so":0,"st":43363.76,"cf":8472.18,"cb":3680.57,"lb":15416.06,"tx":1678},{"date":"2024-01-07","sf":31322.59,"sb":22623.63,"sd":0,"so":0,"st":53946.22,"cf":7457.92,"cb":5553.61,"lb":16997.1,"tx":2090},{"date":"2024-01-14","sf":20175.85,"sb":16220.28,"sd":0,"so":0,"st":36396.13,"cf":5976.75,"cb":2848.12,"lb":12361.19,"tx":1685},{"date":"2024-01-21","sf":19930.97,"sb":16007.71,"sd":0,"so":0,"st":35938.68,"cf":0,"cb":0,"lb":11438.44,"tx":1703},{"date":"2024-01-28","sf":20648.73,"sb":15747.42,"sd":0,"so":0,"st":36396.15,"cf":6623.89,"cb":2874.33,"lb":12841.78,"tx":null},{"date":"2024-02-04","sf":18069.81,"sb":14524.23,"sd":0,"so":0,"st":32594.04,"cf":5167.66,"cb":3644.29,"lb":12290.86,"tx":1560},{"date":"2024-02-11","sf":18329.16,"sb":14338.17,"sd":0,"so":0,"st":32667.33,"cf":4939.22,"cb":2899.48,"lb":11664.52,"tx":1587},{"date":"2024-02-18","sf":17925.12,"sb":14526.97,"sd":0,"so":0,"st":32452.09,"cf":5352.77,"cb":2979.57,"lb":11837.6,"tx":1608},{"date":"2024-02-25","sf":15227.34,"sb":12401.21,"sd":0,"so":0,"st":27628.55,"cf":5582.22,"cb":3123.79,"lb":11514.52,"tx":1502},{"date":"2024-03-03","sf":15976.19,"sb":12621.56,"sd":0,"so":0,"st":28597.75,"cf":4525.13,"cb":2935.36,"lb":11059.27,"tx":1583},{"date":"2024-03-10","sf":14985.92,"sb":12016.42,"sd":0,"so":0,"st":27002.34,"cf":5182.42,"cb":3261.47,"lb":10972.84,"tx":1484},{"date":"2024-03-17","sf":14918.15,"sb":11961.91,"sd":0,"so":0,"st":26880.06,"cf":0,"cb":0,"lb":11186.78,"tx":1492},{"date":"2024-03-24","sf":16259.7,"sb":11975.31,"sd":0,"so":0,"st":28235.01,"cf":5182.07,"cb":0,"lb":11815.2,"tx":1492},{"date":"2024-03-31","sf":18410.74,"sb":12829.72,"sd":0,"so":0,"st":31240.46,"cf":0,"cb":0,"lb":12193.28,"tx":1469},{"date":"2024-04-07","sf":18079.17,"sb":13580.59,"sd":0,"so":0,"st":31659.76,"cf":5835.66,"cb":2128.37,"lb":12335.34,"tx":1559},{"date":"2024-04-14","sf":15336.25,"sb":12136.38,"sd":0,"so":0,"st":27472.63,"cf":4455.11,"cb":2570.48,"lb":10940.39,"tx":1551},{"date":"2024-04-21","sf":17350.3,"sb":13046.3,"sd":0,"so":0,"st":30396.6,"cf":5644.19,"cb":4501.55,"lb":11655.98,"tx":1571},{"date":"2024-04-28","sf":20362.35,"sb":15365.62,"sd":0,"so":0,"st":35727.97,"cf":5552.82,"cb":3118.69,"lb":12522.94,"tx":1664},{"date":"2024-05-05","sf":14618.14,"sb":10820.8,"sd":0,"so":0,"st":25438.94,"cf":4798.71,"cb":2607.65,"lb":11143.0,"tx":1423},{"date":"2024-05-12","sf":15948.6,"sb":12392.67,"sd":0,"so":0,"st":28341.27,"cf":5107.19,"cb":2805.29,"lb":11158.25,"tx":1532},{"date":"2024-05-19","sf":13687.26,"sb":10544.76,"sd":0,"so":0,"st":24232.02,"cf":5053.13,"cb":1672.24,"lb":12230.45,"tx":1335},{"date":"2024-05-26","sf":13020.11,"sb":11316.81,"sd":0,"so":0,"st":24336.92,"cf":4289.5,"cb":0,"lb":9505.32,"tx":1655},{"date":"2024-06-02","sf":14428.19,"sb":11666.94,"sd":0,"so":0,"st":26095.13,"cf":4398.65,"cb":1735.65,"lb":10160.66,"tx":1492},{"date":"2024-06-09","sf":16299.07,"sb":12629.64,"sd":0,"so":0,"st":28928.71,"cf":4251.95,"cb":2419.48,"lb":10775.37,"tx":1492},{"date":"2024-06-16","sf":12715.4,"sb":11441.61,"sd":0,"so":0,"st":24157.01,"cf":3683.91,"cb":1085.32,"lb":10173.52,"tx":1406},{"date":"2024-06-23","sf":12261.29,"sb":10084.61,"sd":0,"so":0,"st":22345.9,"cf":3999.33,"cb":1485.95,"lb":9429.44,"tx":1370},{"date":"2024-06-30","sf":17286.98,"sb":12641.87,"sd":0,"so":0,"st":29928.85,"cf":4103.89,"cb":1952.85,"lb":11214.66,"tx":1519},{"date":"2024-07-07","sf":14800.65,"sb":11594.69,"sd":0,"so":0,"st":26395.34,"cf":4410.6,"cb":3067.44,"lb":10339.56,"tx":1513},{"date":"2024-07-14","sf":15979.27,"sb":12195.02,"sd":0,"so":0,"st":28174.29,"cf":5875.6,"cb":3177.28,"lb":11126.0,"tx":1533},{"date":"2024-07-21","sf":11530.15,"sb":9523.36,"sd":0,"so":0,"st":21053.51,"cf":4032.39,"cb":2427.83,"lb":10148.99,"tx":1235},{"date":"2024-07-28","sf":17919.48,"sb":12973.58,"sd":0,"so":0,"st":30893.06,"cf":5032.12,"cb":2819.36,"lb":12104.71,"tx":1558},{"date":"2024-08-04","sf":12492.86,"sb":10810.95,"sd":0,"so":0,"st":23303.81,"cf":4133.13,"cb":2544.11,"lb":10141.08,"tx":1395},{"date":"2024-08-11","sf":13694.87,"sb":10974.99,"sd":0,"so":0,"st":24669.86,"cf":4508.53,"cb":3106.01,"lb":10532.46,"tx":1609},{"date":"2024-08-18","sf":13055.38,"sb":10781.46,"sd":0,"so":0,"st":23836.84,"cf":4691.1,"cb":2351.23,"lb":9956.13,"tx":1400},{"date":"2024-08-25","sf":14095.59,"sb":11049.04,"sd":0,"so":0,"st":25144.63,"cf":4301.52,"cb":3081.07,"lb":11101.99,"tx":1383},{"date":"2024-09-01","sf":16956.25,"sb":12162.17,"sd":0,"so":0,"st":29118.42,"cf":6680.83,"cb":3481.48,"lb":0,"tx":1626},{"date":"2024-09-08","sf":17135.18,"sb":12123.66,"sd":0,"so":0,"st":29258.84,"cf":0,"cb":0,"lb":12100.15,"tx":1626},{"date":"2024-09-15","sf":17744.8,"sb":13100.57,"sd":0,"so":0,"st":30845.37,"cf":5772.63,"cb":1330.8,"lb":10663.27,"tx":1666},{"date":"2024-09-22","sf":13111.03,"sb":11209.8,"sd":0,"so":0,"st":24320.83,"cf":4791.67,"cb":1985.38,"lb":11158.09,"tx":1589},{"date":"2024-09-29","sf":14590.38,"sb":12005.87,"sd":0,"so":0,"st":26596.25,"cf":4306.26,"cb":3151.54,"lb":9530.24,"tx":1586},{"date":"2024-10-06","sf":15029.8,"sb":11865.88,"sd":0,"so":0,"st":26895.68,"cf":4696.22,"cb":2936.66,"lb":10402.22,"tx":1488},{"date":"2024-10-13","sf":14633.34,"sb":12327.14,"sd":0,"so":0,"st":26960.48,"cf":4690.21,"cb":2766.69,"lb":10383.43,"tx":1423},{"date":"2024-10-20","sf":16569.45,"sb":12634.98,"sd":0,"so":0,"st":29204.43,"cf":7020.56,"cb":3861.95,"lb":12069.04,"tx":1621},{"date":"2024-10-27","sf":15662.95,"sb":12645.63,"sd":0,"so":0,"st":28308.58,"cf":6332.56,"cb":4058.22,"lb":10727.52,"tx":1420},{"date":"2024-11-03","sf":16561.28,"sb":13008.31,"sd":0,"so":0,"st":29569.59,"cf":5142.76,"cb":2819.77,"lb":11049.96,"tx":1482},{"date":"2024-11-10","sf":13259.61,"sb":11301.57,"sd":0,"so":0,"st":24561.18,"cf":3338.05,"cb":2177.83,"lb":9925.1,"tx":1307},{"date":"2024-11-17","sf":11893.68,"sb":10255.07,"sd":0,"so":0,"st":22148.75,"cf":3501.7,"cb":2699.37,"lb":10041.91,"tx":1222},{"date":"2024-11-24","sf":13151.56,"sb":11691.27,"sd":0,"so":0,"st":24842.83,"cf":3826.18,"cb":2819.01,"lb":10311.35,"tx":1338},{"date":"2024-12-01","sf":15811.33,"sb":12340.13,"sd":0,"so":0,"st":28151.46,"cf":4623.09,"cb":3903.89,"lb":12250.8,"tx":1515},{"date":"2024-12-08","sf":17394.54,"sb":11621.86,"sd":0,"so":0,"st":29016.4,"cf":6434.28,"cb":3563.48,"lb":12565.69,"tx":1574},{"date":"2024-12-15","sf":16360.21,"sb":14021.96,"sd":0,"so":0,"st":30382.17,"cf":5688.39,"cb":5486.19,"lb":11951.44,"tx":1558},{"date":"2024-12-22","sf":13385.04,"sb":13054.74,"sd":0,"so":0,"st":26439.78,"cf":5358.1,"cb":5025.36,"lb":9729.6,"tx":1447},{"date":"2024-12-29","sf":17553.09,"sb":14964.22,"sd":0,"so":0,"st":32517.31,"cf":5183.45,"cb":1975.13,"lb":11633.14,"tx":1678},{"date":"2025-01-05","sf":31624.17,"sb":21873.87,"sd":0,"so":0,"st":53498.04,"cf":8115.76,"cb":2875.0,"lb":16522.71,"tx":1953},{"date":"2025-01-12","sf":20101.73,"sb":15980.5,"sd":0,"so":0,"st":36082.23,"cf":4832.87,"cb":3115.46,"lb":11479.73,"tx":1647},{"date":"2025-01-19","sf":15508.01,"sb":12116.57,"sd":0,"so":0,"st":27624.58,"cf":4510.22,"cb":3398.46,"lb":10128.87,"tx":1276},{"date":"2025-01-26","sf":14265.98,"sb":11103.62,"sd":0,"so":0,"st":25369.6,"cf":5339.04,"cb":4354.99,"lb":10788.14,"tx":1286},{"date":"2025-02-02","sf":14839.8,"sb":12103.5,"sd":0,"so":0,"st":26943.3,"cf":4177.76,"cb":2539.22,"lb":0,"tx":1332},{"date":"2025-02-09","sf":14944.79,"sb":12683.08,"sd":0,"so":0,"st":27627.87,"cf":3904.74,"cb":2291.63,"lb":10245.92,"tx":1286},{"date":"2025-02-16","sf":13057.06,"sb":9750.35,"sd":0,"so":0,"st":22807.41,"cf":4844.75,"cb":1605.68,"lb":9863.69,"tx":1187},{"date":"2025-02-23","sf":12524.96,"sb":10765.31,"sd":0,"so":0,"st":23290.27,"cf":3949.66,"cb":1937.15,"lb":9162.97,"tx":1203},{"date":"2025-03-02","sf":14472.91,"sb":10467.55,"sd":0,"so":0,"st":24940.46,"cf":4366.65,"cb":1115.64,"lb":9107.93,"tx":1148},{"date":"2025-03-09","sf":13270.6,"sb":10442.87,"sd":0,"so":0,"st":23713.47,"cf":3136.21,"cb":2191.21,"lb":9637.77,"tx":1244},{"date":"2025-03-16","sf":13682.89,"sb":10261.46,"sd":0,"so":0,"st":23944.35,"cf":3501.85,"cb":1087.3,"lb":8811.73,"tx":1211},{"date":"2025-03-23","sf":12275.86,"sb":10222.11,"sd":0,"so":0,"st":22497.97,"cf":4235.47,"cb":2200.94,"lb":9159.0,"tx":1109},{"date":"2025-03-30","sf":11605.17,"sb":9698.19,"sd":0,"so":0,"st":21303.36,"cf":3640.73,"cb":3317.0,"lb":8767.59,"tx":1108},{"date":"2025-04-06","sf":10999.68,"sb":9350.74,"sd":0,"so":0,"st":20350.42,"cf":3450.22,"cb":1019.48,"lb":8901.34,"tx":1114},{"date":"2025-04-13","sf":12498.77,"sb":10779.97,"sd":0,"so":0,"st":23278.74,"cf":4004.12,"cb":2826.34,"lb":8740.19,"tx":1245},{"date":"2025-04-20","sf":11787.33,"sb":10367.94,"sd":0,"so":0,"st":22155.27,"cf":4366.54,"cb":2042.86,"lb":9928.6,"tx":1124},{"date":"2025-04-27","sf":19168.17,"sb":14128.16,"sd":0,"so":0,"st":33296.33,"cf":3745.32,"cb":2405.32,"lb":11372.39,"tx":1420},{"date":"2025-05-04","sf":11683.97,"sb":9592.9,"sd":0,"so":0,"st":21276.87,"cf":4541.38,"cb":1917.38,"lb":8677.71,"tx":1128},{"date":"2025-05-11","sf":12529.05,"sb":9953.08,"sd":0,"so":0,"st":22482.13,"cf":4307.6,"cb":2128.42,"lb":9023.62,"tx":1145},{"date":"2025-05-18","sf":12086.7,"sb":10059.19,"sd":0,"so":0,"st":22145.89,"cf":3979.5,"cb":2263.1,"lb":8530.22,"tx":1206},{"date":"2025-05-25","sf":12634.34,"sb":12586.1,"sd":0,"so":0,"st":25220.44,"cf":4067.39,"cb":3137.65,"lb":8970.56,"tx":1258},{"date":"2025-06-01","sf":12177.55,"sb":9749.38,"sd":0,"so":0,"st":21926.93,"cf":4554.54,"cb":734.58,"lb":8772.76,"tx":1168},{"date":"2025-06-08","sf":14213.84,"sb":10634.65,"sd":0,"so":0,"st":24848.49,"cf":3468.41,"cb":1881.91,"lb":9208.17,"tx":1193},{"date":"2025-06-15","sf":11624.17,"sb":9010.14,"sd":0,"so":0,"st":20634.31,"cf":0,"cb":0,"lb":8849.95,"tx":1139},{"date":"2025-06-22","sf":14463.65,"sb":10979.2,"sd":0,"so":0,"st":25442.85,"cf":3597.47,"cb":0,"lb":9176.8,"tx":1210},{"date":"2025-06-29","sf":12527.61,"sb":9226.13,"sd":0,"so":0,"st":21753.74,"cf":0,"cb":0,"lb":8381.61,"tx":1111},{"date":"2025-07-06","sf":12937.66,"sb":10092.4,"sd":0,"so":0,"st":23030.06,"cf":0,"cb":0,"lb":8671.99,"tx":null},{"date":"2025-07-13","sf":13696.81,"sb":10355.08,"sd":0,"so":0,"st":24051.89,"cf":0,"cb":0,"lb":8805.48,"tx":null},{"date":"2025-07-20","sf":11613.41,"sb":9053.82,"sd":0,"so":0,"st":20667.23,"cf":3731.09,"cb":2176.62,"lb":8540.4,"tx":null},{"date":"2025-07-27","sf":12574.92,"sb":9861.81,"sd":0,"so":0,"st":22436.73,"cf":0,"cb":0,"lb":8904.8,"tx":null},{"date":"2025-08-03","sf":10669.33,"sb":8384.32,"sd":0,"so":0,"st":19053.65,"cf":0,"cb":0,"lb":0,"tx":null},{"date":"2025-08-10","sf":10403.65,"sb":9020.96,"sd":0,"so":0,"st":19424.61,"cf":3210.89,"cb":1107.26,"lb":7978.69,"tx":1047},{"date":"2025-08-17","sf":11809.48,"sb":10120.0,"sd":0,"so":0,"st":21929.48,"cf":3856.3,"cb":2788.74,"lb":8246.66,"tx":1132},{"date":"2025-08-24","sf":12743.65,"sb":10259.82,"sd":0,"so":0,"st":23003.47,"cf":3631.43,"cb":961.67,"lb":8048.39,"tx":1137},{"date":"2025-08-31","sf":11529.74,"sb":9468.7,"sd":0,"so":0,"st":20998.44,"cf":4218.39,"cb":0,"lb":8215.64,"tx":1044},{"date":"2025-09-07","sf":14169.57,"sb":10591.13,"sd":0,"so":0,"st":24760.7,"cf":4726.41,"cb":2170.69,"lb":8055.8,"tx":1220},{"date":"2025-09-14","sf":10602.0,"sb":8698.87,"sd":0,"so":0,"st":19300.87,"cf":2948.14,"cb":0,"lb":8146.5,"tx":null},{"date":"2025-09-21","sf":11404.17,"sb":9157.22,"sd":0,"so":0,"st":20561.39,"cf":3401.2,"cb":2846.95,"lb":8335.96,"tx":null},{"date":"2025-10-05","sf":12780.87,"sb":10290.87,"sd":0,"so":0,"st":23071.74,"cf":3653.97,"cb":2639.89,"lb":0,"tx":null},{"date":"2025-10-12","sf":10139.83,"sb":8943.13,"sd":0,"so":0,"st":19082.96,"cf":3655.79,"cb":2780.45,"lb":0,"tx":null},{"date":"2025-10-19","sf":12166.78,"sb":9703.91,"sd":0,"so":0,"st":21870.69,"cf":3710.17,"cb":2501.55,"lb":8104.64,"tx":1088},{"date":"2025-10-26","sf":14306.61,"sb":10295.39,"sd":0,"so":0,"st":24602.0,"cf":5235.92,"cb":3482.07,"lb":8929.11,"tx":1112},{"date":"2025-11-02","sf":12608.87,"sb":9867.3,"sd":0,"so":0,"st":22476.17,"cf":3563.64,"cb":1839.67,"lb":8985.47,"tx":1071},{"date":"2025-11-09","sf":12966.52,"sb":9609.65,"sd":0,"so":0,"st":22576.17,"cf":3737.18,"cb":2245.27,"lb":8463.31,"tx":1101},{"date":"2025-11-16","sf":12837.04,"sb":9937.83,"sd":0,"so":0,"st":22774.87,"cf":4150.23,"cb":2870.93,"lb":8503.95,"tx":1132},{"date":"2025-11-23","sf":12527.39,"sb":8839.22,"sd":0,"so":0,"st":21366.61,"cf":3764.38,"cb":3259.45,"lb":8267.23,"tx":1007},{"date":"2025-11-30","sf":13500.0,"sb":10621.04,"sd":0,"so":0,"st":24121.04,"cf":3153.64,"cb":2179.98,"lb":8411.46,"tx":1091},{"date":"2025-12-07","sf":11167.39,"sb":9285.99,"sd":0,"so":0,"st":20453.38,"cf":3704.58,"cb":2431.68,"lb":7788.92,"tx":983},{"date":"2025-12-14","sf":11390.35,"sb":9507.04,"sd":0,"so":0,"st":20897.39,"cf":2910.09,"cb":2304.31,"lb":8480.82,"tx":1039},{"date":"2025-12-21","sf":14565.48,"sb":12869.39,"sd":0,"so":0,"st":27434.87,"cf":5571.16,"cb":3545.56,"lb":9679.77,"tx":1283},{"date":"2025-12-28","sf":17609.22,"sb":13784.7,"sd":0,"so":0,"st":31393.92,"cf":3971.6,"cb":4449.69,"lb":10610.68,"tx":1238},{"date":"2026-01-04","sf":27176.71,"sb":19201.22,"sd":0,"so":0,"st":46377.93,"cf":7083.65,"cb":3399.74,"lb":13421.53,"tx":1657},{"date":"2026-01-11","sf":17440.35,"sb":14988.78,"sd":0,"so":0,"st":32429.13,"cf":5168.51,"cb":2283.12,"lb":9904.17,"tx":1362},{"date":"2026-01-18","sf":15935.22,"sb":12452.96,"sd":0,"so":0,"st":28388.18,"cf":4511.69,"cb":2637.79,"lb":9387.38,"tx":1257},{"date":"2026-01-25","sf":15758.87,"sb":12473.39,"sd":0,"so":0,"st":28232.26,"cf":5223.67,"cb":2350.63,"lb":8996.68,"tx":1253},{"date":"2026-02-01","sf":17001.39,"sb":13589.73,"sd":0,"so":0,"st":30591.12,"cf":4089.18,"cb":3660.98,"lb":9191.6,"tx":1337},{"date":"2026-02-08","sf":16421.0,"sb":12496.17,"sd":0,"so":0,"st":28917.17,"cf":5095.67,"cb":2290.93,"lb":9654.68,"tx":1228},{"date":"2026-02-15","sf":13022.26,"sb":10431.65,"sd":0,"so":0,"st":23453.91,"cf":4297.2,"cb":2401.48,"lb":8424.51,"tx":1117},{"date":"2026-02-22","sf":14854.78,"sb":12192.26,"sd":0,"so":0,"st":27047.04,"cf":3109.4,"cb":2342.11,"lb":8312.43,"tx":1260},{"date":"2026-03-01","sf":13699.57,"sb":11115.57,"sd":0,"so":0,"st":24815.14,"cf":4046.24,"cb":2548.24,"lb":7948.3,"tx":1143},{"date":"2026-03-08","sf":13367.83,"sb":10855.39,"sd":0,"so":0,"st":24223.22,"cf":3716.18,"cb":2746.83,"lb":8118.45,"tx":1155},{"date":"2026-03-15","sf":12625.3,"sb":11602.78,"sd":0,"so":0,"st":24228.08,"cf":4626.19,"cb":2492.91,"lb":9159.08,"tx":1207},{"date":"2026-03-22","sf":11722.0,"sb":10863.3,"sd":0,"so":0,"st":22585.3,"cf":3380.13,"cb":1824.85,"lb":8263.52,"tx":1116},{"date":"2026-03-29","sf":12058.78,"sb":10089.83,"sd":0,"so":0,"st":22148.61,"cf":2609.61,"cb":3331.4,"lb":7793.11,"tx":1065},{"date":"2026-04-05","sf":14805.92,"sb":11816.35,"sd":444.95,"so":0,"st":27067.22,"cf":5769.11,"cb":2519.88,"lb":9004.99,"tx":1142},{"date":"2026-04-12","sf":11380.26,"sb":10370.87,"sd":779.96,"so":0,"st":22531.09,"cf":2515.12,"cb":1107.69,"lb":7249.98,"tx":971},{"date":"2026-04-19","sf":13682.54,"sb":10793.1,"sd":0,"so":0,"st":24475.64,"cf":2586.25,"cb":1929.89,"lb":7726.01,"tx":1122},{"date":"2026-04-26","sf":13418.21,"sb":11393.08,"sd":814.84,"so":0,"st":25626.13,"cf":5324.96,"cb":3923.9,"lb":9296.08,"tx":1204},{"date":"2026-05-03","sf":14485.62,"sb":11866.78,"sd":0,"so":0,"st":26352.4,"cf":3770.79,"cb":1654.91,"lb":8645.3,"tx":1216},{"date":"2026-05-10","sf":14289.74,"sb":10294.83,"sd":0,"so":0,"st":24584.57,"cf":4533.03,"cb":2930.75,"lb":7863.47,"tx":1077},{"date":"2026-05-17","sf":13264.96,"sb":10908.26,"sd":0,"so":0,"st":24173.22,"cf":3437.4,"cb":2241.6,"lb":8550.82,"tx":1184},{"date":"2026-05-24","sf":11306.83,"sb":9647.78,"sd":0,"so":0,"st":20954.61,"cf":2419.08,"cb":3033.99,"lb":7837.6,"tx":1055},{"date":"2026-05-31","sf":11543.0,"sb":10194.09,"sd":0,"so":0,"st":21737.09,"cf":4009.18,"cb":2614.58,"lb":7910.83,"tx":1086},{"date":"2026-06-07","sf":12949.83,"sb":9887.91,"sd":793.11,"so":0,"st":23630.85,"cf":3244.53,"cb":2409.39,"lb":8700.84,"tx":1036},{"date":"2026-06-14","sf":12873.78,"sb":10296.75,"sd":0,"so":0,"st":23170.53,"cf":4439.97,"cb":1966.84,"lb":9011.11,"tx":1126},{"date":"2026-06-21","sf":13166.65,"sb":10451.78,"sd":0,"so":0,"st":23618.43,"cf":4545.18,"cb":2459.01,"lb":8730.47,"tx":1123},{"date":"2026-06-28","sf":12356.61,"sb":9668.35,"sd":0,"so":0,"st":22024.96,"cf":3434.83,"cb":3140.56,"lb":8830.14,"tx":1036},{"date":"2026-07-05","sf":13478.04,"sb":10080.84,"sd":0,"so":0,"st":23558.88,"cf":4058.39,"cb":3920.17,"lb":9029.14,"tx":1121},{"date":"2026-07-12","sf":16014.65,"sb":11051.65,"sd":765.02,"so":0,"st":27831.32,"cf":4165.87,"cb":2000.0,"lb":10440.28,"tx":1119},{"date":"2026-07-19","sf":14718.74,"sb":10780.7,"sd":0,"so":0,"st":25499.44,"cf":5185.76,"cb":2307.09,"lb":9115.1,"tx":1158},{"date":"2026-07-26","sf":11520.52,"sb":9897.22,"sd":0,"so":0,"st":21417.74,"cf":3194.18,"cb":2375.9,"lb":8588.82,"tx":1069},{"date":"2026-08-02","sf":13521.44,"sb":10756.56,"sd":0,"so":0,"st":24278.0,"cf":4451.68,"cb":2477.04,"lb":8997.93,"tx":1195}];
function allWeeksSync() { const m = {}; for (const r of HISTORY) m[r.date] = r; return m; }
async function allWeeks(env) {
  const m = allWeeksSync();
  try { const l = await env.TOKENS.list({ prefix: 'week:' }); for (const k of l.keys) { const raw = await env.TOKENS.get(k.name); if (raw) { try { const r = JSON.parse(raw); if (r && r.date) m[r.date] = r; } catch (e) {} } } } catch (e) {}
  return Object.keys(m).map(function (k) { return m[k]; });
}
function sumWeeks(weeks, from, to) {
  let revenue = 0, cogs = 0, wagesSuper = 0, count = 0, any = false, anyCount = false;
  for (const w of weeks) {
    if (w.date >= from && w.date <= to) {
      any = true;
      revenue += w.st || 0; cogs += (w.cf || 0) + (w.cb || 0); wagesSuper += w.lb || 0;
      if (w.tx) { count += w.tx; anyCount = true; }
    }
  }
  return { any: any, acc: any ? { revenue: revenue, cogs: cogs, wagesSuper: wagesSuper } : null, count: anyCount ? count : null };
}
function monthBounds(mo) { const p = mo.split('-').map(Number); const last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate(); return { from: mo + '-01', to: mo + '-' + String(last).padStart(2, '0') }; }

const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'sheet',
    oauth: {},
    async status(env, h) { return { connected: true, org: null, sandbox: false, lastSync: null }; },
    async fetchRange(env, h, q) {
      const s = sumWeeks(await allWeeks(env), q.from, q.to);
      return s.acc || { revenue: null, cogs: null, wagesSuper: null };
    },
    async fetchMonthly(env, h, q) {
      const weeks = await allWeeks(env);
      const months = monthList(q.fromMonth, q.toMonth);
      const revenue = [], cogs = [], wagesSuper = [];
      for (const mo of months) {
        const b = monthBounds(mo); const s = sumWeeks(weeks, b.from, b.to);
        if (s.any) { revenue.push(s.acc.revenue); cogs.push(s.acc.cogs); wagesSuper.push(s.acc.wagesSuper); }
        else { revenue.push(null); cogs.push(null); wagesSuper.push(null); }
      }
      return { months: months, revenue: revenue, cogs: cogs, wagesSuper: wagesSuper };
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'sheet',
    oauth: {},
    async status(env, h) { return { connected: true, org: null, sandbox: false, lastSync: null }; },
    async fetchRange(env, h, q) {
      const s = sumWeeks(await allWeeks(env), q.from, q.to);
      return { count: s.count };
    },
    async fetchMonthly(env, h, q) {
      const weeks = await allWeeks(env);
      const months = monthList(q.fromMonth, q.toMonth);
      const count = [];
      for (const mo of months) { const b = monthBounds(mo); const s = sumWeeks(weeks, b.from, b.to); count.push(s.any ? s.count : null); }
      return { months: months, count: count };
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function b64urlEnc(str) { return btoa(String(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDec(str) { try { return atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { return ''; } }
async function makeSession(env, role, user) {
  const payload = 'v2.' + Math.floor(Date.now() / 1000) + '.' + (role || 'owner') + '.' + b64urlEnc(user || 'owner');
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function getSession(env, token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return null;
  const parts = payload.split('.');
  const issued = parseInt(parts[1], 10);
  if (!issued || (Date.now() / 1000 - issued) > SESSION_TTL) return null;
  if (parts[0] === 'v2') return { role: parts[2] || 'owner', user: b64urlDec(parts[3] || '') || 'owner' };
  return { role: 'owner', user: 'owner' };
}
async function validSession(env, token) { return !!(await getSession(env, token)); }
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
async function sessionOf(request, env) { return await getSession(env, getCookie(request, 'vd_session')); }

/* ---------------- Staff users + role-based access ---------------- */
const ROLES = ['owner', 'manager', 'headchef', 'supervisor'];
function normId(x) { return String(x || '').trim().toLowerCase().replace(/[^a-z0-9._@-]/g, ''); }
async function getUser(env, id) { if (!env.TOKENS) return null; const raw = await env.TOKENS.get('user:' + id); return raw ? JSON.parse(raw) : null; }
async function listUsers(env) {
  const out = [];
  try { const l = await env.TOKENS.list({ prefix: 'user:' }); for (const k of l.keys) { const u = await getUser(env, k.name.slice(5)); if (u) out.push({ id: u.id, name: u.name, role: u.role }); } } catch (e) {}
  out.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  return out;
}
async function putUser(env, id, name, role, password) {
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  const hash = await pbkdf2B64(password, saltHex);
  await env.TOKENS.put('user:' + id, JSON.stringify({ id: id, name: name, role: role, saltHex: saltHex, hash: hash }));
}
async function apiUserSave(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const id = normId(b && b.id);
  const name = String((b && b.name) || '').slice(0, 60) || id;
  const role = String((b && b.role) || '');
  const password = String((b && b.password) || '');
  if (!id) return json({ ok: false, plain: 'Enter a username (letters and numbers, no spaces).' }, 400);
  if (id === 'owner') return json({ ok: false, plain: 'That username is reserved.' }, 400);
  if (['manager', 'headchef', 'supervisor', 'trainee'].indexOf(role) < 0) return json({ ok: false, plain: 'Pick a role.' }, 400);
  if (password.length < 6) return json({ ok: false, plain: 'Password must be at least 6 characters.' }, 400);
  await putUser(env, id, name, role, password);
  return json({ ok: true, id: id });
}
async function apiUserDelete(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const id = normId(b && b.id);
  if (id && env.TOKENS) await env.TOKENS.delete('user:' + id);
  return json({ ok: true });
}
const TRAINING_DEFAULT = { sections: [
  { id: 'onboarding', title: 'Onboarding / new starter', lessons: [] },
  { id: 'coffee', title: 'Coffee & barista', lessons: [] },
  { id: 'foh', title: 'Front of house / service', lessons: [] },
  { id: 'kitchen', title: 'Kitchen & food safety', lessons: [] }
] };
async function apiWeekSave(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const d = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ ok: false, plain: 'Pick the week-ending date.' }, 400);
  const nf = function (v) { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const sf = nf(b.sf), sb = nf(b.sb), sd = nf(b.sd), so = nf(b.so);
  const st = (b.st !== undefined && b.st !== null && b.st !== '') ? nf(b.st) : (sf + sb + sd + so);
  const rec = { date: d, sf: sf, sb: sb, sd: sd, so: so, st: st, cf: nf(b.cf), cb: nf(b.cb), lb: nf(b.lb), tx: (b.tx !== undefined && b.tx !== null && b.tx !== '') ? parseInt(b.tx, 10) : null };
  await env.TOKENS.put('week:' + d, JSON.stringify(rec));
  try { const mc = await env.TOKENS.list({ prefix: 'metricscache:' }); for (const k of mc.keys) await env.TOKENS.delete(k.name); } catch (e) {}
  return json({ ok: true, date: d });
}
async function apiWeekDelete(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const d = String(b.date || '');
  if (env.TOKENS && /^\d{4}-\d{2}-\d{2}$/.test(d)) { await env.TOKENS.delete('week:' + d); try { const mc = await env.TOKENS.list({ prefix: 'metricscache:' }); for (const k of mc.keys) await env.TOKENS.delete(k.name); } catch (e) {} }
  return json({ ok: true });
}
async function apiWeekList(env) {
  const m = {}; for (const r of HISTORY) m[r.date] = r;
  try { const l = await env.TOKENS.list({ prefix: 'week:' }); for (const k of l.keys) { const raw = await env.TOKENS.get(k.name); if (raw) { try { const r = JSON.parse(raw); m[r.date] = r; } catch (e) {} } } } catch (e) {}
  const arr = Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 16);
  return json({ weeks: arr });
}
async function getTraining(env) {
  if (!env.TOKENS) return TRAINING_DEFAULT;
  const raw = await env.TOKENS.get('training:content');
  if (!raw) return TRAINING_DEFAULT;
  try { return JSON.parse(raw); } catch (e) { return TRAINING_DEFAULT; }
}
async function apiTrainingSave(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const content = b && b.content;
  if (!content || !Array.isArray(content.sections)) return json({ ok: false }, 400);
  const clean = { sections: content.sections.slice(0, 50).map(function (sec) {
    return {
      id: String(sec.id || ('s' + Date.now())).slice(0, 40),
      title: String(sec.title || '').slice(0, 120),
      lessons: Array.isArray(sec.lessons) ? sec.lessons.slice(0, 100).map(function (l) {
        return {
          id: String(l.id || ('l' + Date.now())).slice(0, 40),
          title: String(l.title || '').slice(0, 160),
          video: String(l.video || '').slice(0, 400),
          steps: String(l.steps || '').slice(0, 4000)
        };
      }) : []
    };
  }) };
  await env.TOKENS.put('training:content', JSON.stringify(clean));
  return json({ ok: true });
}
function roleMetrics(role) {
  if (role === 'owner') return ['revenue', 'transactions', 'acs', 'cogs', 'wage', 'overheads', 'profit'];
  if (role === 'trainee') return [];
  if (role === 'manager' || role === 'headchef') return ['revenue', 'transactions', 'acs', 'cogs', 'wage'];
  return ['revenue', 'transactions', 'acs'];
}
function roleAccFields(role) {
  if (role === 'owner') return ['revenue', 'cogs', 'wagesSuper', 'overheads'];
  if (role === 'trainee') return [];
  if (role === 'manager' || role === 'headchef') return ['revenue', 'cogs', 'wagesSuper'];
  return ['revenue'];
}
function filterAccObj(obj, allowed) { if (!obj || typeof obj !== 'object') return obj; const out = {}; allowed.forEach(function (k) { if (k in obj) out[k] = obj[k]; }); return out; }
function filterPeriodsForRole(periods, role) {
  if (role === 'owner' || !periods) return periods;
  const allowed = roleAccFields(role);
  const P = JSON.parse(JSON.stringify(periods));
  ['cur', 'prev', 'yoy'].forEach(function (sl) { if (P[sl] && P[sl].accounting) P[sl].accounting = filterAccObj(P[sl].accounting, allowed); });
  return P;
}
function filterTrendForRole(trend, role) {
  if (role === 'owner' || !trend) return trend;
  const allowed = roleAccFields(role);
  const T = JSON.parse(JSON.stringify(trend));
  if (T.accounting) { const a = {}; allowed.forEach(function (k) { if (k in T.accounting) a[k] = T.accounting[k]; }); T.accounting = a; }
  return T;
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  const username = normId(body && body.username);
  let role = null, user = null;
  if (username) {
    const u = await getUser(env, username);
    if (u && timingSafeEqual(await pbkdf2B64(passcode, u.saltHex), u.hash)) { role = u.role; user = u.id; }
  } else {
    let okPass = false;
    if (env.DASHBOARD_PASSCODE) {
      okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
    } else if (env.TOKENS) {
      const stored = await env.TOKENS.get('sys:passcode_hash');
      if (stored) {
        const dot = stored.indexOf('.');
        okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
      }
    }
    if (okPass) { role = 'owner'; user = 'owner'; }
  }
  if (!role) return json({ ok: false }, 401);
  const token = await makeSession(env, role, user);
  return new Response(JSON.stringify({ ok: true, role: role }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request, sess) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(sess && sess.role === 'owner')) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env, 'owner', 'owner');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FFFFFF;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.brandlogo{width:170px;max-width:72%;display:block;margin:0 auto 1.1rem}.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#43372D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#6FC0E4}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#43372D;background:#6FC0E4;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><img class="brandlogo" src="'+'data:image/png;base64,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'+'" alt="Henry & Ted"><h1>Your dashboard</h1><p>Owners: enter just your password. Staff: your username and password.</p>'
    + '<form id="f"><input id="u" type="text" autocomplete="username" placeholder="Username (staff only)" autofocus><input id="p" type="password" autocomplete="current-password" placeholder="Password" style="margin-top:10px">'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.getElementById("u").value,passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FFFFFF;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.brandlogo{width:170px;max-width:72%;display:block;margin:0 auto 1.1rem}.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#43372D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#6FC0E4}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#43372D;background:#6FC0E4;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><img class="brandlogo" src="'+'data:image/png;base64,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'+'" alt="Henry & Ted"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* Returns the list of whole calendar months a date range exactly covers, or
   null if the range starts mid-month, ends mid-month, or isn't month-aligned.
   Used by the manual-count POS adapter so a count only shows for whole months. */
function wholeMonthsInRange(from, to) {
  const fm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from || '');
  const tm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to || '');
  if (!fm || !tm) return null;
  if (fm[3] !== '01') return null;
  const lastDay = new Date(Date.UTC(+tm[1], +tm[2], 0)).getUTCDate();
  if (+tm[3] !== lastDay) return null;
  return monthList(fm[1] + '-' + fm[2], tm[1] + '-' + tm[2]);
}

/* GET /api/poscount -> { counts: { 'YYYY-MM': n, ... } } (session-authed). */
async function posCountList(env) {
  const out = {};
  try {
    const list = await env.TOKENS.list({ prefix: 'poscount:' });
    for (const k of list.keys) {
      const mo = k.name.slice('poscount:'.length);
      const v = await env.TOKENS.get(k.name);
      const n = parseInt(v, 10);
      if (isFinite(n)) out[mo] = n;
    }
  } catch (e) {}
  return json({ counts: out });
}

/* POST /api/poscount { month:'YYYY-MM', count:int|null } (session-authed).
   Saves/clears the month's transaction count and clears the metrics cache so
   the board reflects it immediately. */
async function posCountSave(env, request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const month = String(body.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, plain: 'Pick a month first.' }, 400);
  if (body.count === null || body.count === '' || typeof body.count === 'undefined') {
    await env.TOKENS.delete('poscount:' + month);
  } else {
    const n = parseInt(body.count, 10);
    if (!isFinite(n) || n < 0) return json({ ok: false, plain: 'Enter a whole number (0 or more).' }, 400);
    await env.TOKENS.put('poscount:' + month, String(n));
  }
  try {
    const mc = await env.TOKENS.list({ prefix: 'metricscache:' });
    for (const k of mc.keys) await env.TOKENS.delete(k.name);
  } catch (e) {}
  await noteSync(env, 'pos');
  return json({ ok: true, month: month });
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      manualCount: !!(st && st.manualCount),
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url, role) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    role: role || 'owner',
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: filterPeriodsForRole(data.periods, role || 'owner'),
    trend: filterTrendForRole(data.trend, role || 'owner')
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });

    const sess = await sessionOf(request, env);
    const loggedIn = !!sess;
    const isOwner = loggedIn && sess.role === 'owner';

    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request, sess);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/me' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return json({ role: sess.role, user: sess.user, metrics: roleMetrics(sess.role), admin: isOwner });
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url, sess.role);
    }
    if (path === '/api/poscount' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return posCountList(env);
    }
    if (path === '/api/poscount' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return posCountSave(env, request);
    }
    if (path === '/api/users' && request.method === 'GET') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return json({ users: await listUsers(env) });
    }
    if (path === '/api/users' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiUserSave(env, request);
    }
    if (path === '/api/users/delete' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiUserDelete(env, request);
    }
    if (path === '/api/training' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return json({ content: await getTraining(env) });
    }
    if (path === '/api/training' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiTrainingSave(env, request);
    }
    if (path === '/api/week' && request.method === 'GET') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiWeekList(env);
    }
    if (path === '/api/week' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiWeekSave(env, request);
    }
    if (path === '/api/week/delete' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiWeekDelete(env, request);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      if (!isOwner) return new Response('Only the owner can change connections.', { status: 403 });
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
