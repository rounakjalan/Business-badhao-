/**
 * Hand-authored to mirror supabase/migrations/*.sql exactly, in the same
 * shape `supabase gen types typescript` produces. Once this project is
 * linked to a live Supabase project, prefer regenerating this file instead
 * of editing it by hand:
 *
 *   npm run db:types
 *
 * (see package.json / README for the underlying `supabase gen types` command)
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type OrgRole = "owner" | "admin" | "member";

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string | null;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string | null;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          role: OrgRole;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role?: OrgRole;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          role?: OrgRole;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      business_goals: {
        Row: {
          id: string;
          organization_id: string;
          title: string;
          description: string | null;
          status: "active" | "archived";
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          title: string;
          description?: string | null;
          status?: "active" | "archived";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          title?: string;
          description?: string | null;
          status?: "active" | "archived";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ideal_customer_profiles: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          description: string | null;
          criteria: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          description?: string | null;
          criteria?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          description?: string | null;
          criteria?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      campaigns: {
        Row: {
          id: string;
          organization_id: string;
          business_goal_id: string | null;
          ideal_customer_profile_id: string | null;
          name: string;
          description: string | null;
          objective: string | null;
          target_audience: string | null;
          status: "draft" | "planning" | "active" | "paused" | "completed" | "archived";
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          business_goal_id?: string | null;
          ideal_customer_profile_id?: string | null;
          name: string;
          description?: string | null;
          objective?: string | null;
          target_audience?: string | null;
          status?: "draft" | "planning" | "active" | "paused" | "completed" | "archived";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          business_goal_id?: string | null;
          ideal_customer_profile_id?: string | null;
          name?: string;
          description?: string | null;
          objective?: string | null;
          target_audience?: string | null;
          status?: "draft" | "planning" | "active" | "paused" | "completed" | "archived";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lead_sources: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          type: "manual" | "import" | "referral" | "website" | "ai_discovery" | "other";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          type?: "manual" | "import" | "referral" | "website" | "ai_discovery" | "other";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          type?: "manual" | "import" | "referral" | "website" | "ai_discovery" | "other";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      prospects: {
        Row: {
          id: string;
          organization_id: string;
          campaign_id: string | null;
          lead_source_id: string | null;
          company_name: string | null;
          contact_name: string | null;
          title: string | null;
          email: string | null;
          phone: string | null;
          website: string | null;
          raw_data: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          campaign_id?: string | null;
          lead_source_id?: string | null;
          company_name?: string | null;
          contact_name?: string | null;
          title?: string | null;
          email?: string | null;
          phone?: string | null;
          website?: string | null;
          raw_data?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          campaign_id?: string | null;
          lead_source_id?: string | null;
          company_name?: string | null;
          contact_name?: string | null;
          title?: string | null;
          email?: string | null;
          phone?: string | null;
          website?: string | null;
          raw_data?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      leads: {
        Row: {
          id: string;
          organization_id: string;
          prospect_id: string | null;
          campaign_id: string | null;
          lead_source_id: string | null;
          status: "new" | "contacted" | "qualified" | "unqualified" | "converted" | "lost";
          qualification_status: "pending" | "qualifying" | "qualified" | "disqualified";
          current_score: number | null;
          intent: string | null;
          next_action: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          prospect_id?: string | null;
          campaign_id?: string | null;
          lead_source_id?: string | null;
          status?: "new" | "contacted" | "qualified" | "unqualified" | "converted" | "lost";
          qualification_status?: "pending" | "qualifying" | "qualified" | "disqualified";
          current_score?: number | null;
          intent?: string | null;
          next_action?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          prospect_id?: string | null;
          campaign_id?: string | null;
          lead_source_id?: string | null;
          status?: "new" | "contacted" | "qualified" | "unqualified" | "converted" | "lost";
          qualification_status?: "pending" | "qualifying" | "qualified" | "disqualified";
          current_score?: number | null;
          intent?: string | null;
          next_action?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          id: string;
          organization_id: string;
          lead_id: string;
          full_name: string | null;
          email: string | null;
          phone: string | null;
          role_title: string | null;
          is_primary: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          lead_id: string;
          full_name?: string | null;
          email?: string | null;
          phone?: string | null;
          role_title?: string | null;
          is_primary?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          lead_id?: string;
          full_name?: string | null;
          email?: string | null;
          phone?: string | null;
          role_title?: string | null;
          is_primary?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lead_research: {
        Row: {
          id: string;
          organization_id: string;
          lead_id: string;
          summary: string | null;
          findings: Json;
          source: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          lead_id: string;
          summary?: string | null;
          findings?: Json;
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          lead_id?: string;
          summary?: string | null;
          findings?: Json;
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lead_scores: {
        Row: {
          id: string;
          organization_id: string;
          lead_id: string;
          score: number;
          reason: string | null;
          scored_by: "system" | "agent" | "manual";
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          lead_id: string;
          score: number;
          reason?: string | null;
          scored_by?: "system" | "agent" | "manual";
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          lead_id?: string;
          score?: number;
          reason?: string | null;
          scored_by?: "system" | "agent" | "manual";
          created_at?: string;
        };
        Relationships: [];
      };
      outreach_campaigns: {
        Row: {
          id: string;
          organization_id: string;
          campaign_id: string;
          name: string;
          channel: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "other";
          status: "draft" | "active" | "paused" | "completed";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          campaign_id: string;
          name: string;
          channel?: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "other";
          status?: "draft" | "active" | "paused" | "completed";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          campaign_id?: string;
          name?: string;
          channel?: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "other";
          status?: "draft" | "active" | "paused" | "completed";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      conversations: {
        Row: {
          id: string;
          organization_id: string;
          lead_id: string;
          campaign_id: string | null;
          channel: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "web_chat" | "other";
          status: "open" | "pending" | "resolved" | "closed";
          intent: string | null;
          last_message_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          lead_id: string;
          campaign_id?: string | null;
          channel?: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "web_chat" | "other";
          status?: "open" | "pending" | "resolved" | "closed";
          intent?: string | null;
          last_message_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          lead_id?: string;
          campaign_id?: string | null;
          channel?: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "web_chat" | "other";
          status?: "open" | "pending" | "resolved" | "closed";
          intent?: string | null;
          last_message_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          organization_id: string;
          conversation_id: string | null;
          outreach_campaign_id: string | null;
          lead_id: string | null;
          direction: "inbound" | "outbound";
          channel: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "web_chat" | "other";
          sender_type: "lead" | "agent" | "human" | "system";
          body: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          conversation_id?: string | null;
          outreach_campaign_id?: string | null;
          lead_id?: string | null;
          direction: "inbound" | "outbound";
          channel?: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "web_chat" | "other";
          sender_type?: "lead" | "agent" | "human" | "system";
          body?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          conversation_id?: string | null;
          outreach_campaign_id?: string | null;
          lead_id?: string | null;
          direction?: "inbound" | "outbound";
          channel?: "email" | "sms" | "whatsapp" | "instagram" | "linkedin" | "phone" | "web_chat" | "other";
          sender_type?: "lead" | "agent" | "human" | "system";
          body?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      conversation_events: {
        Row: {
          id: string;
          organization_id: string;
          conversation_id: string;
          event_type: string;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          conversation_id: string;
          event_type: string;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          conversation_id?: string;
          event_type?: string;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      deals: {
        Row: {
          id: string;
          organization_id: string;
          lead_id: string | null;
          campaign_id: string | null;
          title: string;
          status: "open" | "negotiation" | "won" | "lost";
          value: number;
          currency: string;
          probability: number | null;
          expected_close_date: string | null;
          won_at: string | null;
          lost_at: string | null;
          loss_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          lead_id?: string | null;
          campaign_id?: string | null;
          title: string;
          status?: "open" | "negotiation" | "won" | "lost";
          value?: number;
          currency?: string;
          probability?: number | null;
          expected_close_date?: string | null;
          won_at?: string | null;
          lost_at?: string | null;
          loss_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          lead_id?: string | null;
          campaign_id?: string | null;
          title?: string;
          status?: "open" | "negotiation" | "won" | "lost";
          value?: number;
          currency?: string;
          probability?: number | null;
          expected_close_date?: string | null;
          won_at?: string | null;
          lost_at?: string | null;
          loss_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      deal_events: {
        Row: {
          id: string;
          organization_id: string;
          deal_id: string;
          event_type: string;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          deal_id: string;
          event_type: string;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          deal_id?: string;
          event_type?: string;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      loss_analysis: {
        Row: {
          id: string;
          organization_id: string;
          deal_id: string;
          reason_category: string | null;
          summary: string | null;
          details: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          deal_id: string;
          reason_category?: string | null;
          summary?: string | null;
          details?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          deal_id?: string;
          reason_category?: string | null;
          summary?: string | null;
          details?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      recovery_attempts: {
        Row: {
          id: string;
          organization_id: string;
          deal_id: string;
          loss_analysis_id: string | null;
          status: "planned" | "in_progress" | "succeeded" | "failed";
          notes: string | null;
          attempted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          deal_id: string;
          loss_analysis_id?: string | null;
          status?: "planned" | "in_progress" | "succeeded" | "failed";
          notes?: string | null;
          attempted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          deal_id?: string;
          loss_analysis_id?: string | null;
          status?: "planned" | "in_progress" | "succeeded" | "failed";
          notes?: string | null;
          attempted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_runs: {
        Row: {
          id: string;
          organization_id: string;
          agent_type: string;
          status: "pending" | "running" | "completed" | "failed";
          input: Json;
          output: Json;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          agent_type: string;
          status?: "pending" | "running" | "completed" | "failed";
          input?: Json;
          output?: Json;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          agent_type?: string;
          status?: "pending" | "running" | "completed" | "failed";
          input?: Json;
          output?: Json;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      agent_actions: {
        Row: {
          id: string;
          organization_id: string;
          agent_run_id: string;
          action_type: string;
          target_entity_type: string | null;
          target_entity_id: string | null;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          agent_run_id: string;
          action_type: string;
          target_entity_type?: string | null;
          target_entity_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          agent_run_id?: string;
          action_type?: string;
          target_entity_type?: string | null;
          target_entity_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          organization_id: string;
          title: string;
          description: string | null;
          status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
          related_entity_type: string | null;
          related_entity_id: string | null;
          assigned_to: string | null;
          due_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          title: string;
          description?: string | null;
          status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
          related_entity_type?: string | null;
          related_entity_id?: string | null;
          assigned_to?: string | null;
          due_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          title?: string;
          description?: string | null;
          status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
          related_entity_type?: string | null;
          related_entity_id?: string | null;
          assigned_to?: string | null;
          due_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      model_usage: {
        Row: {
          id: string;
          organization_id: string;
          agent_run_id: string | null;
          provider: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          agent_run_id?: string | null;
          provider: string;
          model: string;
          input_tokens?: number;
          output_tokens?: number;
          cost_usd?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          agent_run_id?: string | null;
          provider?: string;
          model?: string;
          input_tokens?: number;
          output_tokens?: number;
          cost_usd?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string | null;
          user_id: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          user_id?: string | null;
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          user_id?: string | null;
          action?: string;
          entity_type?: string | null;
          entity_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      business_profiles: {
        Row: {
          id: string;
          organization_id: string;
          business_name: string | null;
          business_description: string | null;
          business_category: string | null;
          website: string | null;
          phone: string | null;
          email: string | null;
          whatsapp: string | null;
          address: string | null;
          service_area: string | null;
          opening_hours: string | null;
          about: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          business_name?: string | null;
          business_description?: string | null;
          business_category?: string | null;
          website?: string | null;
          phone?: string | null;
          email?: string | null;
          whatsapp?: string | null;
          address?: string | null;
          service_area?: string | null;
          opening_hours?: string | null;
          about?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          business_name?: string | null;
          business_description?: string | null;
          business_category?: string | null;
          website?: string | null;
          phone?: string | null;
          email?: string | null;
          whatsapp?: string | null;
          address?: string | null;
          service_area?: string | null;
          opening_hours?: string | null;
          about?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      products_services: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          description: string | null;
          category: string | null;
          price: number | null;
          pricing_type: "fixed" | "starting_at" | "hourly" | "per_unit" | "custom";
          features: Json;
          benefits: Json;
          availability: "available" | "out_of_stock" | "seasonal" | "coming_soon";
          special_offers: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          description?: string | null;
          category?: string | null;
          price?: number | null;
          pricing_type?: "fixed" | "starting_at" | "hourly" | "per_unit" | "custom";
          features?: Json;
          benefits?: Json;
          availability?: "available" | "out_of_stock" | "seasonal" | "coming_soon";
          special_offers?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          description?: string | null;
          category?: string | null;
          price?: number | null;
          pricing_type?: "fixed" | "starting_at" | "hourly" | "per_unit" | "custom";
          features?: Json;
          benefits?: Json;
          availability?: "available" | "out_of_stock" | "seasonal" | "coming_soon";
          special_offers?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      media_assets: {
        Row: {
          id: string;
          organization_id: string;
          category: "logo" | "product" | "service" | "location" | "video" | "brochure" | "catalogue" | "price_list" | "document" | "other";
          storage_path: string;
          file_name: string;
          mime_type: string | null;
          file_size: number | null;
          title: string | null;
          description: string | null;
          product_service_id: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          category: "logo" | "product" | "service" | "location" | "video" | "brochure" | "catalogue" | "price_list" | "document" | "other";
          storage_path: string;
          file_name: string;
          mime_type?: string | null;
          file_size?: number | null;
          title?: string | null;
          description?: string | null;
          product_service_id?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          category?: "logo" | "product" | "service" | "location" | "video" | "brochure" | "catalogue" | "price_list" | "document" | "other";
          storage_path?: string;
          file_name?: string;
          mime_type?: string | null;
          file_size?: number | null;
          title?: string | null;
          description?: string | null;
          product_service_id?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      faqs: {
        Row: {
          id: string;
          organization_id: string;
          question: string;
          answer: string;
          category: string | null;
          is_active: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          question: string;
          answer: string;
          category?: string | null;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          question?: string;
          answer?: string;
          category?: string | null;
          is_active?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      business_policies: {
        Row: {
          id: string;
          organization_id: string;
          policy_type: "refund" | "cancellation" | "delivery" | "admission" | "payment" | "other";
          title: string;
          content: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          policy_type: "refund" | "cancellation" | "delivery" | "admission" | "payment" | "other";
          title: string;
          content: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          policy_type?: "refund" | "cancellation" | "delivery" | "admission" | "payment" | "other";
          title?: string;
          content?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ai_communication_rules: {
        Row: {
          id: string;
          organization_id: string;
          brand_voice: string | null;
          preferred_language: string | null;
          formality: string | null;
          key_selling_points: Json;
          must_emphasize: Json;
          must_never_claim: Json;
          competitor_comparison_rules: string | null;
          discount_authority: string | null;
          escalation_rules: string | null;
          handoff_triggers: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          brand_voice?: string | null;
          preferred_language?: string | null;
          formality?: string | null;
          key_selling_points?: Json;
          must_emphasize?: Json;
          must_never_claim?: Json;
          competitor_comparison_rules?: string | null;
          discount_authority?: string | null;
          escalation_rules?: string | null;
          handoff_triggers?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          brand_voice?: string | null;
          preferred_language?: string | null;
          formality?: string | null;
          key_selling_points?: Json;
          must_emphasize?: Json;
          must_never_claim?: Json;
          competitor_comparison_rules?: string | null;
          discount_authority?: string | null;
          escalation_rules?: string | null;
          handoff_triggers?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_org_member: {
        Args: { target_org: string };
        Returns: boolean;
      };
      is_org_admin: {
        Args: { target_org: string };
        Returns: boolean;
      };
      is_org_owner: {
        Args: { target_org: string };
        Returns: boolean;
      };
      current_org_role: {
        Args: { target_org: string };
        Returns: OrgRole;
      };
      create_organization_with_owner: {
        Args: { org_name: string };
        Returns: Database["public"]["Tables"]["organizations"]["Row"];
      };
    };
    Enums: {
      org_role: OrgRole;
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Tables<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Update"];
