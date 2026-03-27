"use client";

import { CITIES, PlaceType, PLACE_TYPE_LABELS } from "@/lib/types";

interface Filters {
  city: string;
  district: string;
  placeType: string;
  search: string;
}

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export default function FilterBar({ filters, onChange }: Props) {
  const districts = filters.city ? CITIES[filters.city] || [] : [];

  return (
    <div className="space-y-3">
      <input
        type="text"
        placeholder="搜尋名稱或標籤..."
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        className="w-full px-3 py-2 rounded-xl border border-border bg-card text-sm outline-none focus:ring-2 focus:ring-primary"
      />
      <div className="flex gap-2 overflow-x-auto pb-1">
        <select
          value={filters.city}
          onChange={(e) =>
            onChange({ ...filters, city: e.target.value, district: "" })
          }
          className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
        >
          <option value="">所有縣市</option>
          {Object.keys(CITIES).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {filters.city && districts.length > 0 && (
          <select
            value={filters.district}
            onChange={(e) =>
              onChange({ ...filters, district: e.target.value })
            }
            className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
          >
            <option value="">所有區域</option>
            {districts.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}

        <select
          value={filters.placeType}
          onChange={(e) =>
            onChange({ ...filters, placeType: e.target.value })
          }
          className="px-3 py-1.5 rounded-full border border-border bg-card text-sm shrink-0"
        >
          <option value="">所有類型</option>
          {(Object.entries(PLACE_TYPE_LABELS) as [PlaceType, string][]).map(
            ([key, label]) => (
              <option key={key} value={key}>{label}</option>
            )
          )}
        </select>
      </div>
    </div>
  );
}
