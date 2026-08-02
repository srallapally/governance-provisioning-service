import { describe, it, expect } from "vitest";
import { checkAudienceIdentityCollapse } from "../../src/http/identityCheck.js";

describe("checkAudienceIdentityCollapse", () => {
  it("warns when the inbound audience and IGA_CLIENT_ID are the same value", () => {
    const warning = checkAudienceIdentityCollapse(
        { clientId: "svc-client" },
        { expectedAudience: "svc-client" },
    );
    expect(warning).toMatch(/svc-client/);
    expect(warning).toMatch(/JWT_EXPECTED_AUD/);
    expect(warning).toMatch(/IGA_CLIENT_ID/);
  });

  it("returns null when the two identities are distinct", () => {
    const warning = checkAudienceIdentityCollapse(
        { clientId: "svc-client" },
        { expectedAudience: "idmAdminClient" },
    );
    expect(warning).toBeNull();
  });

  it("returns null when there is no IGA block at all (file store)", () => {
    const warning = checkAudienceIdentityCollapse(undefined, { expectedAudience: "idmAdminClient" });
    expect(warning).toBeNull();
  });
});
