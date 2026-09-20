import { redirect } from 'next/navigation';

export default function WorkbookLinksPage() {
  // Preserve old bookmarks while opening configuration over the live workbook.
  redirect('/?panel=workbook-links');
}
