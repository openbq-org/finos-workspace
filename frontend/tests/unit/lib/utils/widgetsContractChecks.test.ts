import { describe, expect, it } from "vitest";
import { contractProblems } from "~/lib/utils/widgetsContractChecks";

const widget = (params: Record<string, unknown>[]) => ({
  name: "N",
  description: "D",
  endpoint: "/n",
  type: "markdown",
  method: "POST",
  params,
});
const messages = (params: Record<string, unknown>[]) =>
  contractProblems(widget(params)).map((p) => p.message);

describe("bodyRoot", () => {
  it("is fine on one text param in the body", () => {
    expect(
      messages([{ paramName: "gridState", type: "text", in: "body", bodyRoot: true }]),
    ).toEqual([]);
  });

  it("needs in: body", () => {
    expect(messages([{ paramName: "s", type: "text", bodyRoot: true }])).toEqual([
      '`s` puts its keys at the top of the body, so it needs `in: "body"`',
    ]);
  });

  it("takes one value", () => {
    expect(
      messages([
        { paramName: "s", type: "text", in: "body", bodyRoot: true, multiple: true },
      ]),
    ).toEqual(["`s` fills the body with one JSON object, so it takes one value"]);
  });

  it("is on one param at most", () => {
    expect(
      messages([
        { paramName: "a", type: "text", in: "body", bodyRoot: true },
        { paramName: "b", type: "text", in: "body", bodyRoot: true },
      ]),
    ).toEqual(["only one param can fill the top of the body (`bodyRoot`)"]);
  });
});
