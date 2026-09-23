import { render, screen, fireEvent } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { GeometryRow } from "./GeometryRow.tsx";

describe("GeometryRow", () => {
    it("shows a placeholder when geometry is not edited", () => {
        render(
            <GeometryRow straighten={0} zoom={1} cropX={0} cropY={0} focused={false} onClick={() => {}} />,
        );
        expect(screen.getByText("Crop & Straighten…")).toBeTruthy();
    });

    it("shows the values when geometry is edited", () => {
        render(
            <GeometryRow straighten={3} zoom={1.2} cropX={0.1} cropY={-0.2} focused={false} onClick={() => {}} />,
        );
        expect(screen.getByText(/3\.0°\s+1\.20×/)).toBeTruthy();
    });

    it("shows distortion and perspective values when edited", () => {
        render(
            <GeometryRow
                straighten={0}
                zoom={1}
                cropX={0}
                cropY={0}
                distortion={15}
                perspectiveV={-10}
                perspectiveH={5}
                focused={false}
                onClick={() => {}}
            />,
        );
        expect(screen.getByText(/Dist:\s*\+15\s+V:\s*-10\s+H:\s*\+5/)).toBeTruthy();
    });

    it("calls onClick when the row is clicked (mouse)", () => {
        const onClick = vi.fn();
        render(
            <GeometryRow straighten={0} zoom={1} cropX={0} cropY={0} focused onClick={onClick} />,
        );
        fireEvent.click(screen.getByText("Crop & Straighten…"));
        expect(onClick).toHaveBeenCalled();
    });
});
