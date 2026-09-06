import { describe, expect, it } from "vitest";
import { selectOutreachChannel } from "@/lib/outreach/channel-selection";

const FULLY_ELIGIBLE = {
  whatsappEnabledForCampaign: true,
  whatsappConnected: true,
  whatsappTemplateConfigured: true,
  phone: "+91 98765 43210",
  gmailConnected: false,
};

describe("selectOutreachChannel", () => {
  it("picks WhatsApp when everything required is in place", () => {
    expect(selectOutreachChannel(FULLY_ELIGIBLE)).toEqual({ channel: "whatsapp" });
  });

  it("still picks WhatsApp even when Gmail is also connected — never both channels at once", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, gmailConnected: true })).toEqual({ channel: "whatsapp" });
  });

  it("falls through to gmail_manual (never an automatic Gmail send) when the campaign has WhatsApp turned off", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, whatsappEnabledForCampaign: false, gmailConnected: true })).toEqual({
      channel: "gmail_manual",
      whatsappIneligibleReason: "campaign_disabled",
    });
  });

  it("reports none when the campaign has WhatsApp off and Gmail isn't connected either", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, whatsappEnabledForCampaign: false, gmailConnected: false })).toEqual({
      channel: "none",
      whatsappIneligibleReason: "campaign_disabled",
    });
  });

  it("falls through to gmail_manual when WhatsApp isn't connected", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, whatsappConnected: false, gmailConnected: true })).toEqual({
      channel: "gmail_manual",
      whatsappIneligibleReason: "not_connected",
    });
  });

  it("falls through to gmail_manual when WhatsApp is connected but has no approved template", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, whatsappTemplateConfigured: false, gmailConnected: true })).toEqual({
      channel: "gmail_manual",
      whatsappIneligibleReason: "template_not_configured",
    });
  });

  it("falls through to gmail_manual when the lead has no phone at all", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, phone: null, gmailConnected: true })).toEqual({
      channel: "gmail_manual",
      whatsappIneligibleReason: "invalid_or_missing_phone",
    });
  });

  it("falls through to gmail_manual when the lead's phone is too short/garbage to be real", () => {
    expect(selectOutreachChannel({ ...FULLY_ELIGIBLE, phone: "123", gmailConnected: true })).toEqual({
      channel: "gmail_manual",
      whatsappIneligibleReason: "invalid_or_missing_phone",
    });
  });

  it("reports none (never a fabricated channel) when nothing at all is available", () => {
    expect(
      selectOutreachChannel({ whatsappEnabledForCampaign: true, whatsappConnected: false, whatsappTemplateConfigured: false, phone: null, gmailConnected: false })
    ).toEqual({ channel: "none", whatsappIneligibleReason: "not_connected" });
  });
});
