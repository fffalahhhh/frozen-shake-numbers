import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileDown,
} from "lucide-react";
import { useFetch, type HistoryDay, type Shop } from "../api";
import { useSession } from "../session";
import { useSync } from "../sync";
import {
  addMonths,
  fmtDate,
  inr,
  monthBounds,
  toPaise,
  todayIn,
  type Method,
} from "../lib";
import {
  DateField,
  Empty,
  MethodSeg,
  PageHead,
  Sheet,
  Skeleton,
  type SheetHandle,
} from "../ui";
import { dayLabel, inHandLabel, methodLabel } from "./Today";

type Totals = {
  revenue: string;
  expenses: string;
  handovers: string;
  net: string;
  openingBalance: string;
  closingBalance: string;
};
type Mode = "all" | "month" | "range";

export default function History() {
  const shop = useSession().shop as Shop;
  const navigate = useNavigate();
  const today = todayIn(shop.timezone);
  const thisMonth = monthBounds(today)[0];
  const [mode, setMode] = useState<Mode>("all");
  const [month, setMonth] = useState(thisMonth);
  const [range, setRange] = useState({ from: thisMonth, to: today });
  const [method, setMethod] = useState<Method | "">("");
  const [exporting, setExporting] = useState(false);

  const [from, to] =
    mode === "all"
      ? ["2000-01-01", today]
      : mode === "month"
      ? monthBounds(month)
      : [range.from, range.to];
  const { data, loading, error, reload } = useFetch<{
    days: HistoryDay[];
    totals: Totals;
  }>(
    `/shops/${shop.id}/history?from=${from}&to=${to}${
      method ? `&method=${method}` : ""
    }`,
  );
  const days = data?.days ?? [];

  return (
    <>
      <PageHead
        eyebrow="Your records"
        title="History"
        sub="Every day you’ve recorded. Open a day to see and edit all of its entries."
      />

      <PeriodPicker
        mode={mode}
        setMode={setMode}
        month={month}
        setMonth={setMonth}
        range={range}
        setRange={setRange}
        today={today}
      />
      <MethodSeg value={method} onChange={setMethod} all />

      {data && days.length > 0 && (
        <div className="totals">
          <div>
            <span>Revenue</span>
            <b>{inr(toPaise(data.totals.revenue))}</b>
          </div>
          <div>
            <span>Expenses</span>
            <b>{inr(toPaise(data.totals.expenses))}</b>
          </div>
          <div>
            <span>Handed over</span>
            <b>{inr(toPaise(data.totals.handovers))}</b>
          </div>
          <div>
            <span>
              {inHandLabel[method]}
              {mode === "all" ? "" : " at end"}
            </span>
            <b>{inr(toPaise(data.totals.closingBalance))}</b>
          </div>
        </div>
      )}

      <div className="sectionHead">
        <p className="hint" style={{ margin: 0 }}>
          {days.length} {days.length === 1 ? "day" : "days"} recorded · In hand
          is the running balance
        </p>
        <button className="link" onClick={() => setExporting(true)}>
          <FileDown size={15} style={{ verticalAlign: -3 }} /> Export PDF
        </button>
      </div>

      {error && !data ? (
        <div className="banner danger">
          <span className="grow">
            {error.status === 0
              ? "You’re offline and this period isn’t saved on this device yet."
              : error.message}
          </span>
          <button className="pill" onClick={reload}>
            Retry
          </button>
        </div>
      ) : loading && !data ? (
        <Skeleton rows={4} />
      ) : days.length === 0 ? (
        <Empty
          icon={CalendarDays}
          title={
            method
              ? `No ${methodLabel[method]}entries in this period`
              : "Your history starts here"
          }
          text="Each day you record revenue, expenses or a partner handover will appear here."
        />
      ) : (
        <>
          <div className="histHead">
            <span>Date</span>
            <span className="figs">
              <span>Revenue</span>
              <span>Expenses</span>
              <span>Handed over</span>
              <span>In hand</span>
            </span>
          </div>
          <div className="list">
            {days.map((d) => {
              const [name, date] = dayLabel(d.date, today);
              return (
                <button
                  key={d.date}
                  className="row histRow"
                  onClick={() => navigate(`/history/${d.date}`)}
                >
                  <span className="iconTile soft">
                    <CalendarDays size={19} strokeWidth={1.7} />
                  </span>
                  <span className="rowCopy">
                    <b>
                      {name}, {date}
                    </b>
                    <small className="sumLine">
                      In {inr(toPaise(d.revenue))} · Spent{" "}
                      {inr(toPaise(d.expenses))}
                      {toPaise(d.handovers)
                        ? ` · Out ${inr(toPaise(d.handovers))}`
                        : ""}
                    </small>
                  </span>
                  <span className="figs">
                    <span>{inr(toPaise(d.revenue))}</span>
                    <span>{inr(toPaise(d.expenses))}</span>
                    <span>{inr(toPaise(d.handovers))}</span>
                  </span>
                  <span
                    className={
                      "amount" + (toPaise(d.balance) >= 0 ? " pos" : "")
                    }
                  >
                    {inr(toPaise(d.balance))}
                  </span>
                  <ChevronRight className="chev" size={16} />
                </button>
              );
            })}
          </div>
        </>
      )}
      {exporting && (
        <ExportSheet
          shop={shop}
          today={today}
          initial={{ mode, month, range, method }}
          onClose={() => setExporting(false)}
        />
      )}
    </>
  );
}

type Range = { from: string; to: string };

function PeriodPicker({
  mode,
  setMode,
  month,
  setMonth,
  range,
  setRange,
  today,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  month: string;
  setMonth: (m: string) => void;
  range: Range;
  setRange: (r: Range) => void;
  today: string;
}) {
  const thisMonth = monthBounds(today)[0];
  return (
    <>
      <div className="seg" role="tablist">
        {(
          [
            ["all", "All time"],
            ["month", "By month"],
            ["range", "Date range"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={mode === k}
            className={mode === k ? "on" : ""}
            onClick={() => setMode(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "month" && (
        <div className="monthBar">
          <button
            type="button"
            className="iconBtn"
            onClick={() => setMonth(addMonths(month, -1))}
            aria-label="Previous month"
          >
            <ChevronLeft size={20} />
          </button>
          <b>{fmtDate(month, { month: "long", year: "numeric" })}</b>
          <button
            type="button"
            className="iconBtn"
            onClick={() => setMonth(addMonths(month, 1))}
            disabled={month >= thisMonth}
            aria-label="Next month"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      )}
      {mode === "range" && (
        <div className="rangeRow">
          <label className="field">
            <span>From</span>
            <DateField
              value={range.from}
              max={range.to}
              onChange={(d) => setRange({ ...range, from: d })}
              label="From"
            />
          </label>
          <label className="field">
            <span>To</span>
            <DateField
              value={range.to}
              min={range.from}
              max={today}
              onChange={(d) => setRange({ ...range, to: d })}
              label="To"
            />
          </label>
        </div>
      )}
    </>
  );
}

const SECTIONS = [
  ["expenses", "Expenses by category"],
  ["handovers", "Handovers by partner"],
  ["revenue", "Revenue"],
  ["days", "Daily totals", "Per month for long periods"],
] as const;

/** Choose a period and what to include, then download the statement PDF (built by the server). */
function ExportSheet({
  shop,
  today,
  initial,
  onClose,
}: {
  shop: Shop;
  today: string;
  initial: { mode: Mode; month: string; range: Range; method: Method | "" };
  onClose: () => void;
}) {
  const sheet = useRef<SheetHandle>(null);
  const { online } = useSync();
  const [mode, setMode] = useState(initial.mode);
  const [month, setMonth] = useState(initial.month);
  const [range, setRange] = useState(initial.range);
  const [method, setMethod] = useState(initial.method);
  const [sections, setSections] = useState<string[]>(SECTIONS.map(([k]) => k));
  const [items, setItems] = useState(true);

  const [from, to] =
    mode === "all"
      ? ["", today]
      : mode === "month"
      ? monthBounds(month)
      : [range.from, range.to];
  const q = new URLSearchParams({
    ...(from && { from }),
    to,
    ...(method && { method }),
    sections: sections.join(","),
    ...(items && { items: "1" }),
  });
  const href = `/api/shops/${shop.id}/export.pdf?${q}`;
  const grouped =
    sections.includes("expenses") || sections.includes("handovers");
  const toggle = (k: string, on: boolean) =>
    setSections(
      SECTIONS.map(([s]) => s).filter((s) =>
        s === k ? on : sections.includes(s),
      ),
    );

  // Phones get the share sheet ("Save to Files" on iPhone): an installed iOS
  // app just previews a downloaded PDF with no way to keep it.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState<{ href: string; file: File } | null>(null);
  const file = ready?.href === href ? ready.file : null;
  const share = async (f: File) => {
    try {
      await navigator.share({ files: [f] });
      sheet.current?.dismiss();
    } catch (e) {
      // NotAllowedError: the tap expired while the PDF was being made, so the
      // button now reads "Save PDF" and shares on the next tap. AbortError: closed.
      if (!["NotAllowedError", "AbortError"].includes((e as Error).name))
        setError("Couldn’t share the PDF");
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(href, { credentials: "same-origin" });
      if (res.status === 401)
        window.dispatchEvent(new Event("fs:unauthorized"));
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => null))?.error?.message ??
            "Couldn’t create the PDF",
        );
      const name =
        /filename="?([^";]+)/.exec(
          res.headers.get("Content-Disposition") ?? "",
        )?.[1] ?? "Statement.pdf";
      const f = new File([await res.blob()], name, { type: "application/pdf" });
      if (
        matchMedia("(pointer: coarse)").matches &&
        navigator.canShare?.({ files: [f] })
      ) {
        setReady({ href, file: f });
        await share(f);
      } else {
        const a = Object.assign(document.createElement("a"), {
          href: URL.createObjectURL(f),
          download: name,
        });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
        sheet.current?.dismiss();
      }
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "You’re offline. Connect to download the PDF."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet ref={sheet} open onClose={onClose} title="Export PDF">
      <PeriodPicker
        mode={mode}
        setMode={setMode}
        month={month}
        setMonth={setMonth}
        range={range}
        setRange={setRange}
        today={today}
      />
      <MethodSeg value={method} onChange={setMethod} all />
      <div className="list">
        {SECTIONS.map(([k, label, sub]) => (
          <label className="switchRow" key={k}>
            <span className="rowCopy">
              <b>{label}</b>
              {sub && <small>{sub}</small>}
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={sections.includes(k)}
              onChange={(e) => toggle(k, e.target.checked)}
            />
          </label>
        ))}
      </div>
      <div className="list mt">
        <label className="switchRow">
          <span className="rowCopy">
            <b>List each entry</b>
            <small>Off shows only each category’s total</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={items && grouped}
            disabled={!grouped}
            onChange={(e) => setItems(e.target.checked)}
          />
        </label>
      </div>
      {!online && (
        <p className="formError">
          You’re offline. Connect to download the PDF.
        </p>
      )}
      {error && <p className="formError">{error}</p>}
      <div className="sheetActions mt">
        {file ? (
          <button className="btn big" onClick={() => share(file)}>
            <FileDown size={18} /> Save PDF
          </button>
        ) : (
          <button
            className="btn big"
            onClick={save}
            disabled={!online || busy || sections.length === 0}
          >
            <FileDown size={18} /> {busy ? "Preparing PDF…" : "Download PDF"}
          </button>
        )}
      </div>
      {file && (
        <p className="hint">
          Choose “Save to Files” to keep it on this device.
        </p>
      )}
    </Sheet>
  );
}
