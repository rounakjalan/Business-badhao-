"use client";

import { useState, useTransition } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { DarkAlert } from "@/components/dashboard-ui/alert";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { KnowledgeIcon } from "@/components/ui/icons";
import { formatCurrency } from "@/lib/format";
import type { Tables } from "@/types/database.types";

type BusinessProfile = Tables<"business_profiles">;
type ProductService = Tables<"products_services">;
type MediaAsset = Tables<"media_assets"> & { signedUrl: string | null };
type Faq = Tables<"faqs">;
type Policy = Tables<"business_policies">;
type AiRules = Tables<"ai_communication_rules">;

type Actions = {
  updateBusinessProfile: (formData: FormData) => void;
  createProductService: (formData: FormData) => void;
  updateProductService: (id: string, formData: FormData) => void;
  deleteProductService: (id: string) => void;
  uploadMediaAsset: (formData: FormData) => void;
  deleteMediaAsset: (id: string) => void;
  createFaq: (formData: FormData) => void;
  updateFaq: (id: string, formData: FormData) => void;
  toggleFaqActive: (id: string, isActive: boolean) => void;
  deleteFaq: (id: string) => void;
  createPolicy: (formData: FormData) => void;
  updatePolicy: (id: string, formData: FormData) => void;
  deletePolicy: (id: string) => void;
  updateAiCommunicationRules: (formData: FormData) => void;
};

const TABS = ["Business Profile", "Products & Services", "Media & Assets", "FAQs", "Policies", "AI Communication Rules"] as const;
type Tab = (typeof TABS)[number];

const TAB_SLUG: Record<Tab, string> = {
  "Business Profile": "profile",
  "Products & Services": "products",
  "Media & Assets": "media",
  FAQs: "faqs",
  Policies: "policies",
  "AI Communication Rules": "ai-rules",
};
const SLUG_TAB = Object.fromEntries(Object.entries(TAB_SLUG).map(([k, v]) => [v, k])) as Record<string, Tab>;

const MESSAGES: Record<string, string> = {
  "profile-updated": "Business profile saved.",
  "rules-updated": "AI communication rules saved.",
};

export function KnowledgeTabs({
  error,
  message,
  initialTab,
  businessProfile,
  products,
  media,
  faqs,
  policies,
  aiRules,
  actions,
}: {
  error?: string;
  message?: string;
  initialTab?: string;
  businessProfile: BusinessProfile | null;
  products: ProductService[];
  media: MediaAsset[];
  faqs: Faq[];
  policies: Policy[];
  aiRules: AiRules | null;
  actions: Actions;
}) {
  const [tab, setTab] = useState<Tab>((initialTab && SLUG_TAB[initialTab]) || "Business Profile");

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Knowledge Base"
        description="Business context future AI agents (conversations, qualification, outreach, deals) will use"
      />

      {error ? <DarkAlert variant="error">{error}</DarkAlert> : null}
      {message && MESSAGES[message] ? <DarkAlert variant="success">{MESSAGES[message]}</DarkAlert> : null}

      <div className="flex gap-1 overflow-x-auto border-b border-bb-border pb-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
              tab === t ? "bg-bb-indigo/15 text-bb-indigo-2" : "text-bb-text-3 hover:text-bb-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Business Profile" ? <BusinessProfileTab profile={businessProfile} action={actions.updateBusinessProfile} /> : null}
      {tab === "Products & Services" ? (
        <ProductsTab
          products={products}
          onCreate={actions.createProductService}
          onUpdate={actions.updateProductService}
          onDelete={actions.deleteProductService}
        />
      ) : null}
      {tab === "Media & Assets" ? (
        <MediaTab media={media} products={products} onUpload={actions.uploadMediaAsset} onDelete={actions.deleteMediaAsset} />
      ) : null}
      {tab === "FAQs" ? (
        <FaqsTab faqs={faqs} onCreate={actions.createFaq} onUpdate={actions.updateFaq} onToggle={actions.toggleFaqActive} onDelete={actions.deleteFaq} />
      ) : null}
      {tab === "Policies" ? (
        <PoliciesTab policies={policies} onCreate={actions.createPolicy} onUpdate={actions.updatePolicy} onDelete={actions.deletePolicy} />
      ) : null}
      {tab === "AI Communication Rules" ? <AiRulesTab rules={aiRules} action={actions.updateAiCommunicationRules} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared field primitives (same visual language as Settings)
// ---------------------------------------------------------------------------
function inputClass() {
  return "w-full rounded-lg border border-bb-border bg-bb-navy px-4 py-2.5 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo";
}

function Field({ label, name, defaultValue, placeholder, type = "text" }: { label: string; name: string; defaultValue?: string; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-bb-text-2">{label}</label>
      <input name={name} type={type} defaultValue={defaultValue ?? ""} placeholder={placeholder} className={inputClass()} />
    </div>
  );
}

function TextareaField({ label, name, defaultValue, rows = 3, hint }: { label: string; name: string; defaultValue?: string; rows?: number; hint?: string }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-bb-text-2">
        {label}
        {hint ? <span className="ml-1.5 font-normal text-bb-text-3">{hint}</span> : null}
      </label>
      <textarea name={name} rows={rows} defaultValue={defaultValue ?? ""} className={`${inputClass()} resize-none`} />
    </div>
  );
}

function SelectField({ label, name, defaultValue, options }: { label: string; name: string; defaultValue?: string; options: { value: string; label: string }[] }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-bb-text-2">{label}</label>
      <select name={name} defaultValue={defaultValue} className={inputClass()}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Business Profile
// ---------------------------------------------------------------------------
function BusinessProfileTab({ profile, action }: { profile: BusinessProfile | null; action: (formData: FormData) => void }) {
  return (
    <DarkCard className="max-w-3xl p-6">
      <form action={action} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Business Name" name="businessName" defaultValue={profile?.business_name ?? ""} placeholder="e.g. Sunrise Public School" />
          <Field label="Business Category" name="businessCategory" defaultValue={profile?.business_category ?? ""} placeholder="e.g. K-12 School" />
        </div>
        <TextareaField label="Business Description" name="businessDescription" defaultValue={profile?.business_description ?? ""} rows={2} />
        <TextareaField label="About the Business" name="about" defaultValue={profile?.about ?? ""} rows={4} hint="Longer-form context for AI and customers" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Website" name="website" defaultValue={profile?.website ?? ""} placeholder="https://" />
          <Field label="Phone" name="phone" defaultValue={profile?.phone ?? ""} />
          <Field label="Email" name="email" type="email" defaultValue={profile?.email ?? ""} />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="WhatsApp" name="whatsapp" defaultValue={profile?.whatsapp ?? ""} />
          <Field label="Opening Hours" name="openingHours" defaultValue={profile?.opening_hours ?? ""} placeholder="e.g. Mon-Sat, 9am-6pm" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Address / Location" name="address" defaultValue={profile?.address ?? ""} />
          <Field label="Service Area" name="serviceArea" defaultValue={profile?.service_area ?? ""} placeholder="e.g. Noida, 10km radius" />
        </div>
        <DashButton type="submit" variant="gradient">
          Save Business Profile
        </DashButton>
      </form>
    </DarkCard>
  );
}

// ---------------------------------------------------------------------------
// Products & Services
// ---------------------------------------------------------------------------
const PRICING_TYPES = [
  { value: "fixed", label: "Fixed" },
  { value: "starting_at", label: "Starting at" },
  { value: "hourly", label: "Hourly" },
  { value: "per_unit", label: "Per unit" },
  { value: "custom", label: "Custom" },
];
const AVAILABILITY_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "out_of_stock", label: "Out of stock" },
  { value: "seasonal", label: "Seasonal" },
  { value: "coming_soon", label: "Coming soon" },
];

function ProductForm({
  product,
  onSubmit,
  onCancel,
}: {
  product?: ProductService;
  onSubmit: (formData: FormData) => void;
  onCancel?: () => void;
}) {
  return (
    <form action={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" defaultValue={product?.name} placeholder="e.g. Grade 5 Admission" />
        <Field label="Category" name="category" defaultValue={product?.category ?? ""} />
      </div>
      <TextareaField label="Description" name="description" defaultValue={product?.description ?? ""} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Price" name="price" type="number" defaultValue={product?.price != null ? String(product.price) : ""} />
        <SelectField label="Pricing Type" name="pricingType" defaultValue={product?.pricing_type ?? "fixed"} options={PRICING_TYPES} />
      </div>
      <SelectField label="Availability" name="availability" defaultValue={product?.availability ?? "available"} options={AVAILABILITY_OPTIONS} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextareaField label="Features" name="features" defaultValue={(product?.features as string[] | null)?.join("\n") ?? ""} hint="one per line" />
        <TextareaField label="Benefits" name="benefits" defaultValue={(product?.benefits as string[] | null)?.join("\n") ?? ""} hint="one per line" />
      </div>
      <TextareaField label="Special Offers" name="specialOffers" defaultValue={product?.special_offers ?? ""} rows={2} />
      <div className="flex gap-3">
        <DashButton type="submit" variant="gradient">
          {product ? "Save Changes" : "Add Product / Service"}
        </DashButton>
        {onCancel ? (
          <DashButton type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </DashButton>
        ) : null}
      </div>
    </form>
  );
}

function ProductsTab({
  products,
  onCreate,
  onUpdate,
  onDelete,
}: {
  products: ProductService[];
  onCreate: (formData: FormData) => void;
  onUpdate: (id: string, formData: FormData) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="max-w-3xl space-y-4">
      {adding ? (
        <DarkCard className="p-6">
          <ProductForm onSubmit={onCreate} onCancel={() => setAdding(false)} />
        </DarkCard>
      ) : (
        <DashButton variant="gradient" onClick={() => setAdding(true)}>
          + Add Product / Service
        </DashButton>
      )}

      {products.length === 0 && !adding ? (
        <DarkEmptyState icon={KnowledgeIcon} title="No products or services yet" description="Add what you sell so AI agents can talk about it accurately." />
      ) : (
        <div className="space-y-3">
          {products.map((p) =>
            editingId === p.id ? (
              <DarkCard key={p.id} className="p-6">
                <ProductForm product={p} onSubmit={(fd) => onUpdate(p.id, fd)} onCancel={() => setEditingId(null)} />
              </DarkCard>
            ) : (
              <DarkCard key={p.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-display text-sm font-semibold text-bb-text">{p.name}</div>
                    <div className="text-xs text-bb-text-3">
                      {p.category ?? "Uncategorized"} · {p.price != null ? formatCurrency(p.price, "INR") : "No price set"} ({p.pricing_type}) ·{" "}
                      {p.availability.replace("_", " ")}
                    </div>
                    {p.description ? <p className="mt-2 text-sm text-bb-text-2">{p.description}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <DashButton variant="ghost" onClick={() => setEditingId(p.id)}>
                      Edit
                    </DashButton>
                    <DashButton variant="danger" disabled={pending} onClick={() => startTransition(() => onDelete(p.id))}>
                      Delete
                    </DashButton>
                  </div>
                </div>
              </DarkCard>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media & Assets
// ---------------------------------------------------------------------------
const MEDIA_CATEGORIES = [
  { value: "logo", label: "Logo" },
  { value: "product", label: "Product image" },
  { value: "service", label: "Service image" },
  { value: "location", label: "Campus / store / office image" },
  { value: "video", label: "Video" },
  { value: "brochure", label: "Brochure" },
  { value: "catalogue", label: "Catalogue" },
  { value: "price_list", label: "Price list" },
  { value: "document", label: "Document" },
  { value: "other", label: "Other" },
];

function MediaTab({
  media,
  products,
  onUpload,
  onDelete,
}: {
  media: MediaAsset[];
  products: ProductService[];
  onUpload: (formData: FormData) => void;
  onDelete: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="max-w-3xl space-y-4">
      <DarkCard className="p-6">
        <form action={onUpload} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-bb-text-2">File</label>
            <input type="file" name="file" required className="block w-full text-sm text-bb-text-2 file:mr-3 file:rounded-lg file:border-0 file:bg-bb-indigo/15 file:px-3 file:py-2 file:text-xs file:font-medium file:text-bb-indigo-2" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField label="Category" name="category" defaultValue="other" options={MEDIA_CATEGORIES} />
            {products.length > 0 ? (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Linked Product / Service (optional)</label>
                <select name="productServiceId" defaultValue="" className={inputClass()}>
                  <option value="">None</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          <Field label="Title (optional)" name="title" />
          <DashButton type="submit" variant="gradient">
            Upload
          </DashButton>
        </form>
      </DarkCard>

      {media.length === 0 ? (
        <DarkEmptyState icon={KnowledgeIcon} title="No assets uploaded yet" description="Logos, product photos, brochures, catalogues, and price lists all go here." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {media.map((m) => (
            <DarkCard key={m.id} className="overflow-hidden p-0">
              {m.signedUrl && m.mime_type?.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed, expiring, per-tenant Supabase Storage URLs aren't a fit for next/image's remote-pattern allowlist
                <img src={m.signedUrl} alt={m.title ?? m.file_name} className="h-32 w-full object-cover" />
              ) : (
                <div className="flex h-32 w-full items-center justify-center bg-bb-navy-3 text-xs text-bb-text-3">{m.category}</div>
              )}
              <div className="space-y-2 p-3">
                <div className="truncate text-xs font-medium text-bb-text">{m.title || m.file_name}</div>
                <div className="text-[11px] text-bb-text-3 capitalize">{m.category.replace("_", " ")}</div>
                <div className="flex gap-2">
                  {m.signedUrl ? (
                    <a href={m.signedUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-bb-indigo-2 hover:underline">
                      View
                    </a>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => startTransition(() => onDelete(m.id))}
                    className="text-xs text-bb-rose hover:underline disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </DarkCard>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FAQs
// ---------------------------------------------------------------------------
function FaqForm({ faq, onSubmit, onCancel }: { faq?: Faq; onSubmit: (formData: FormData) => void; onCancel?: () => void }) {
  return (
    <form action={onSubmit} className="space-y-4">
      <Field label="Question" name="question" defaultValue={faq?.question} />
      <TextareaField label="Answer" name="answer" defaultValue={faq?.answer} />
      <Field label="Category (optional)" name="category" defaultValue={faq?.category ?? ""} />
      <div className="flex gap-3">
        <DashButton type="submit" variant="gradient">
          {faq ? "Save Changes" : "Add FAQ"}
        </DashButton>
        {onCancel ? (
          <DashButton type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </DashButton>
        ) : null}
      </div>
    </form>
  );
}

function FaqsTab({
  faqs,
  onCreate,
  onUpdate,
  onToggle,
  onDelete,
}: {
  faqs: Faq[];
  onCreate: (formData: FormData) => void;
  onUpdate: (id: string, formData: FormData) => void;
  onToggle: (id: string, isActive: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="max-w-3xl space-y-4">
      {adding ? (
        <DarkCard className="p-6">
          <FaqForm onSubmit={onCreate} onCancel={() => setAdding(false)} />
        </DarkCard>
      ) : (
        <DashButton variant="gradient" onClick={() => setAdding(true)}>
          + Add FAQ
        </DashButton>
      )}

      {faqs.length === 0 && !adding ? (
        <DarkEmptyState icon={KnowledgeIcon} title="No FAQs yet" description="Common questions and answers AI can draw on when talking to customers." />
      ) : (
        <div className="space-y-3">
          {faqs.map((f) =>
            editingId === f.id ? (
              <DarkCard key={f.id} className="p-6">
                <FaqForm faq={f} onSubmit={(fd) => onUpdate(f.id, fd)} onCancel={() => setEditingId(null)} />
              </DarkCard>
            ) : (
              <DarkCard key={f.id} className={`p-5 ${f.is_active ? "" : "opacity-50"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-bb-text">{f.question}</div>
                    <p className="mt-1 text-sm text-bb-text-2">{f.answer}</p>
                    {f.category ? <div className="mt-1 text-xs text-bb-text-3">{f.category}</div> : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <DashButton variant="ghost" disabled={pending} onClick={() => startTransition(() => onToggle(f.id, !f.is_active))}>
                      {f.is_active ? "Deactivate" : "Activate"}
                    </DashButton>
                    <DashButton variant="ghost" onClick={() => setEditingId(f.id)}>
                      Edit
                    </DashButton>
                    <DashButton variant="danger" disabled={pending} onClick={() => startTransition(() => onDelete(f.id))}>
                      Delete
                    </DashButton>
                  </div>
                </div>
              </DarkCard>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
const POLICY_TYPES = [
  { value: "refund", label: "Refund" },
  { value: "cancellation", label: "Cancellation" },
  { value: "delivery", label: "Delivery / Service" },
  { value: "admission", label: "Admission" },
  { value: "payment", label: "Payment" },
  { value: "other", label: "Other" },
];

function PolicyForm({ policy, onSubmit, onCancel }: { policy?: Policy; onSubmit: (formData: FormData) => void; onCancel?: () => void }) {
  return (
    <form action={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField label="Policy Type" name="policyType" defaultValue={policy?.policy_type ?? "other"} options={POLICY_TYPES} />
        <Field label="Title" name="title" defaultValue={policy?.title} />
      </div>
      <TextareaField label="Content" name="content" defaultValue={policy?.content} rows={5} />
      <div className="flex gap-3">
        <DashButton type="submit" variant="gradient">
          {policy ? "Save Changes" : "Add Policy"}
        </DashButton>
        {onCancel ? (
          <DashButton type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </DashButton>
        ) : null}
      </div>
    </form>
  );
}

function PoliciesTab({
  policies,
  onCreate,
  onUpdate,
  onDelete,
}: {
  policies: Policy[];
  onCreate: (formData: FormData) => void;
  onUpdate: (id: string, formData: FormData) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="max-w-3xl space-y-4">
      {adding ? (
        <DarkCard className="p-6">
          <PolicyForm onSubmit={onCreate} onCancel={() => setAdding(false)} />
        </DarkCard>
      ) : (
        <DashButton variant="gradient" onClick={() => setAdding(true)}>
          + Add Policy
        </DashButton>
      )}

      {policies.length === 0 && !adding ? (
        <DarkEmptyState icon={KnowledgeIcon} title="No policies added yet" description="Refund, cancellation, delivery, and other rules AI should never contradict." />
      ) : (
        <div className="space-y-3">
          {policies.map((p) =>
            editingId === p.id ? (
              <DarkCard key={p.id} className="p-6">
                <PolicyForm policy={p} onSubmit={(fd) => onUpdate(p.id, fd)} onCancel={() => setEditingId(null)} />
              </DarkCard>
            ) : (
              <DarkCard key={p.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-bb-text">
                      {p.title} <span className="ml-1 text-xs font-normal capitalize text-bb-text-3">({p.policy_type})</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-bb-text-2">{p.content}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <DashButton variant="ghost" onClick={() => setEditingId(p.id)}>
                      Edit
                    </DashButton>
                    <DashButton variant="danger" disabled={pending} onClick={() => startTransition(() => onDelete(p.id))}>
                      Delete
                    </DashButton>
                  </div>
                </div>
              </DarkCard>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Communication Rules
// ---------------------------------------------------------------------------
function AiRulesTab({ rules, action }: { rules: AiRules | null; action: (formData: FormData) => void }) {
  return (
    <DarkCard className="max-w-3xl p-6">
      <form action={action} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Brand Voice" name="brandVoice" defaultValue={rules?.brand_voice ?? ""} placeholder="e.g. Warm, encouraging, expert" />
          <Field label="Preferred Language" name="preferredLanguage" defaultValue={rules?.preferred_language ?? ""} placeholder="e.g. English, Hindi, Hinglish" />
        </div>
        <Field label="Formality" name="formality" defaultValue={rules?.formality ?? ""} placeholder="e.g. Friendly but professional" />
        <TextareaField label="Key Selling Points" name="keySellingPoints" defaultValue={((rules?.key_selling_points as string[] | null) ?? []).join("\n")} hint="one per line" />
        <TextareaField label="Things AI Must Emphasize" name="mustEmphasize" defaultValue={((rules?.must_emphasize as string[] | null) ?? []).join("\n")} hint="one per line" />
        <TextareaField label="Things AI Must Never Claim" name="mustNeverClaim" defaultValue={((rules?.must_never_claim as string[] | null) ?? []).join("\n")} hint="one per line" />
        <TextareaField label="Competitor / Comparison Rules" name="competitorComparisonRules" defaultValue={rules?.competitor_comparison_rules ?? ""} rows={2} />
        <TextareaField label="Discount Authority" name="discountAuthority" defaultValue={rules?.discount_authority ?? ""} rows={2} hint="What discounts, if any, AI can offer on its own" />
        <TextareaField label="Escalation Rules" name="escalationRules" defaultValue={rules?.escalation_rules ?? ""} rows={2} />
        <TextareaField label="When AI Must Hand Off to a Human" name="handoffTriggers" defaultValue={((rules?.handoff_triggers as string[] | null) ?? []).join("\n")} hint="one per line" />
        <DashButton type="submit" variant="gradient">
          Save AI Communication Rules
        </DashButton>
      </form>
    </DarkCard>
  );
}
