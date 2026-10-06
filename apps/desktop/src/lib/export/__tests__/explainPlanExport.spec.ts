import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../i18n/locales/en";
import type { ParsedExplainPlan } from "../../diagram/explainPlan";
import { EXPLAIN_PLAN_EXPORT_COLUMN_KEYS, explainPlanExportRows, saveExplainPlanExport } from "../explainPlanExport";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(() => false),
  save: vi.fn<() => Promise<string | null>>(),
  csv: vi.fn(),
  xlsx: vi.fn(),
  html: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: mocks.desktop }));
vi.mock("../exportPath", () => ({ promptExportSavePath: mocks.save }));
vi.mock("@/lib/backend/api", () => ({ exportQueryResultCsv: mocks.csv, exportQueryResultXlsx: mocks.xlsx, exportQueryResultHtml: mocks.html }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { csvQuoteMode: "all", csvNullMode: "marker" } }) }));

function fixture(): ParsedExplainPlan {
  return {
    databaseType: "oracle",
    raw: "raw plan",
    nodes: [
      {
        id: "0",
        title: "SELECT STATEMENT",
        nodeType: "SELECT STATEMENT",
        cost: "148 (0)",
        rows: "0",
        details: [],
        children: [
          {
            id: "1",
            title: "INDEX RANGE SCAN",
            nodeType: "INDEX RANGE SCAN",
            relation: "用户",
            index: "IDX_USERS",
            cost: "0.29..1830.12",
            rows: "96M",
            estimatedTimeUs: "12",
            details: ["Predicate: name = 'a,\"b\"' AND x < 4", "Time: 00:00:01\nActual Rows: 0"],
            children: [],
          },
        ],
      },
    ],
  };
}

const columns = EXPLAIN_PLAN_EXPORT_COLUMN_KEYS.map((key) => en.explain[key.slice("explain.".length) as keyof typeof en.explain]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop.mockReturnValue(false);
});

describe("Explain Plan Summary export", () => {
  it("preserves all six Summary columns, hierarchy, native values and full details", () => {
    expect(columns).toEqual(["Node", "Table", "Index", "Cost", "Rows", "Details"]);
    const plan = fixture();
    plan.nodes.push({ id: "0", title: "SECOND ROOT", nodeType: "RESULT", details: [], children: [] });
    expect(explainPlanExportRows(plan.nodes, "Estimated time")).toEqual([
      ["SELECT STATEMENT", "-", "-", "148 (0)", "0", "-"],
      ["  INDEX RANGE SCAN", "用户", "IDX_USERS", "0.29..1830.12", "96M", "Estimated time: 12 µs; Predicate: name = 'a,\"b\"' AND x < 4; Time: 00:00:01\nActual Rows: 0"],
      ["SECOND ROOT", "-", "-", "-", "-", "-"],
    ]);
  });

  it.each(["html", "csv", "xlsx"] as const)("sends the same complete Summary to the %s writer in the web runtime", async (format) => {
    const plan = fixture();
    const rows = explainPlanExportRows(plan.nodes, "Estimated time");
    expect(await saveExplainPlanExport(plan, format, columns, "Estimated time", "Explain Plan")).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
    if (format === "html") expect(mocks.html).toHaveBeenCalledWith("explain-plan-oracle.html", "Explain Plan", columns, rows);
    if (format === "csv") expect(mocks.csv).toHaveBeenCalledWith("explain-plan-oracle.csv", columns, rows, "all", "\\N");
    if (format === "xlsx") expect(mocks.xlsx).toHaveBeenCalledWith("explain-plan-oracle.xlsx", "Explain Plan", columns, Array(6).fill("TEXT"), undefined, rows);
  });

  it("does not write a file when the desktop save dialog is canceled", async () => {
    mocks.desktop.mockReturnValue(true);
    mocks.save.mockResolvedValueOnce(null);
    expect(await saveExplainPlanExport(fixture(), "csv", columns, "Estimated time", "Explain Plan")).toBe(false);
    expect(mocks.csv).not.toHaveBeenCalled();
  });

  it("keeps the original snapshot when the plan changes while choosing a path", async () => {
    mocks.desktop.mockReturnValue(true);
    const plan = fixture();
    mocks.save.mockImplementationOnce(async () => {
      plan.nodes[0].title = "NEW QUERY";
      plan.nodes[0].children = [];
      return "C:\\exports\\plan.html";
    });
    await saveExplainPlanExport(plan, "html", columns, "Estimated time", "Explain Plan");
    const exportedRows = mocks.html.mock.calls[0][3];
    expect(exportedRows).toHaveLength(2);
    expect(exportedRows[0][0]).toBe("SELECT STATEMENT");
    expect(mocks.html.mock.calls[0][0]).toBe("C:\\exports\\plan.html");
  });

  it("propagates writer failures for the viewer to report", async () => {
    mocks.xlsx.mockRejectedValueOnce(new Error("Disk full"));
    await expect(saveExplainPlanExport(fixture(), "xlsx", columns, "Estimated time", "Explain Plan")).rejects.toThrow("Disk full");
  });

  it("does not export an empty parsed plan", async () => {
    expect(await saveExplainPlanExport({ databaseType: "oracle", raw: "unparsed", nodes: [] }, "html", columns, "Estimated time", "Explain Plan")).toBe(false);
    expect(mocks.html).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
