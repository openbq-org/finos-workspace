import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailsForm } from "~/plugins/SettingsForm";

describe("the card's name and description in Settings", () => {
  it("edits the name and the description of the card", () => {
    const onChange = vi.fn();
    render(
      <CardDetailsForm
        values={{
          name: "Trades SQL (static)",
          description: "A static copy of Trades SQL",
        }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Trades at close" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      name: "Trades at close",
      description: "A static copy of Trades SQL",
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Closing book" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      name: "Trades SQL (static)",
      description: "Closing book",
    });
  });

  it("is read-only on a shared dashboard", () => {
    render(
      <CardDetailsForm
        values={{ name: "A", description: "" }}
        onChange={vi.fn()}
        disabled={true}
      />,
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Description")).toBeDisabled();
  });
});
