import React, { useEffect, useMemo, useRef, useState } from 'react';
import { query_uploaded_cookies, UploadedRecord } from '../utils/functions';

interface Props { endpoint: string; password: string; headers: string }

export default function UploadedCookies({ endpoint, password, headers }: Props) {
  const [records, setRecords] = useState<UploadedRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const requestId = useRef(0);
  useEffect(() => { requestId.current++; setRecords(null); setError(''); setLoading(false); }, [endpoint, password, headers]);
  const rows = useMemo(() => (records || []).flatMap(record =>
    Object.entries(record.data?.cookie_data || {}).flatMap(([domain, cookies]) =>
      Array.isArray(cookies) ? cookies.map(cookie => ({ uuid: record.uuid, domain, cookie })) : []
    )
  ), [records]);
  const filtered = useMemo(() => {
    const keyword = search.toLowerCase();
    return rows.filter(row => [row.uuid, row.domain, row.cookie.domain, row.cookie.name, row.cookie.value].some(value => String(value || '').toLowerCase().includes(keyword)));
  }, [rows, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / 100));
  const currentPage = Math.min(page, pages - 1);

  const query = async () => {
    const id = ++requestId.current;
    setLoading(true); setError(''); setRecords(null); setPage(0);
    try {
      if (!endpoint.trim()) throw new Error('请先填写服务器地址');
      const result = await query_uploaded_cookies(endpoint, password, headers);
      if (id === requestId.current) setRecords(result);
    } catch (error) {
      if (id === requestId.current) setError(error instanceof Error ? error.message : '查询失败');
    } finally { if (id === requestId.current) setLoading(false); }
  };

  return <section className="border-t border-gray-200 mt-8 pt-6">
    <h3 className="text-lg font-semibold text-gray-800">服务端所有 UUID 的 Cookie</h3>
    <p className="text-sm text-gray-500 mt-2">查询全部已上传记录。加密记录使用当前填写的密码解密；不同密码的记录需换用对应密码后重新查询。</p>
    <button className="btn btn-primary mt-3 disabled:opacity-50" disabled={loading} onClick={query}>
      {loading ? '查询中…' : '查询 / 刷新全部记录'}
    </button>
    {error && <p role="alert" className="text-red-600 mt-3">{error}</p>}
    {records && <>
      <p className="text-sm text-gray-600 my-3">共 {records.length} 个 UUID，已读取 {rows.length} 个 Cookie，{records.filter(record => record.error).length} 个 UUID 无法读取。</p>
      <div className="space-y-2">
        {records.map(record => <details key={record.uuid} className="rounded border p-3 text-sm">
          <summary className="cursor-pointer break-all">{record.uuid} · {record.crypto_type} · {record.error || `${Object.values(record.data?.cookie_data || {}).reduce((count, cookies) => count + (Array.isArray(cookies) ? cookies.length : 0), 0)} 个 Cookie`}</summary>
          {record.data && <>
            <p className="text-gray-500 mt-2">更新时间：{record.data.update_time || '未知'}</p>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all bg-gray-50 p-3">{JSON.stringify(record.data, null, 2)}</pre>
          </>}
        </details>)}
      </div>
      <input aria-label="搜索上传的 Cookie" className="form-input mt-4" placeholder="搜索 UUID、域名、Cookie 名称或值" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />
      <p className="text-sm text-gray-500 my-2">匹配 {filtered.length} 个 Cookie</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left table-fixed">
          <thead className="bg-gray-100"><tr>{['UUID', '域名', '名称', '值', '路径'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
          <tbody>{filtered.slice(currentPage * 100, (currentPage + 1) * 100).map((row, index) => <tr key={`${currentPage}-${index}`} className="border-b align-top">
            {[row.uuid, row.cookie.domain || row.domain, row.cookie.name, row.cookie.value, row.cookie.path].map((value, column) => <td key={column} className="p-2 break-all whitespace-pre-wrap">{String(value ?? '')}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-gray-500 mt-3">没有可展示的 Cookie。</p>}
      <div className="flex items-center gap-3 mt-3">
        <button className="btn bg-gray-100 disabled:opacity-50" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <span className="text-sm">{currentPage + 1} / {pages}</span>
        <button className="btn bg-gray-100 disabled:opacity-50" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div>
    </>}
  </section>;
}
