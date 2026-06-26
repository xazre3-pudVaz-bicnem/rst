export interface Case {
  id: string
  name: string
  address: string
  phone1: string
  phone2?: string | null
  phone3?: string | null
  industry?: string | null
  representative?: string | null
  status: string
  sales_rep?: string | null
  hp1?: string | null
  hp2?: string | null
  instagram?: string | null
  source_urls?: string | null
  memo?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface Appointment {
  id: string
  case_id: string
  case_name: string
  address?: string | null
  sales_rep?: string | null
  appo_at: string
  memo?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface Recall {
  id: string
  case_id: string
  case_name: string
  target_at: string
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface CallLog {
  id: string
  case_id: string
  case_name: string
  call_at: string
  contact_type: '接触' | '非接触'
  result?: string | null
  memo?: string | null
  summary?: string | null
  created_by_id?: string | null
  created_date: string
  updated_date: string
}

export interface CallSession {
  id: string
  session_key: string
  case_id?: string | null
  case_name?: string | null
  phone1?: string | null
  phone2?: string | null
  phone3?: string | null
  created_date: string
  updated_date: string
}

/** Auto search settings stored in localStorage */
export interface AutoSearchSettings {
  enabled: boolean
  intervalMinutes: number
}

/** Shop extracted by LLM search */
export interface ExtractedShop {
  name: string
  address?: string
  phone1?: string
  phone2?: string
  industry?: string
  representative?: string
  hp1?: string
  hp2?: string
  instagram?: string
  source_urls?: string
  memo?: string
}
