import {notFound} from 'next/navigation';
import {pageUser} from '@/lib/standalone/session';
import {getReviewDetail} from '@/lib/standalone/review';
import {ReviewItemDetail} from '@/components/standalone/review-item-detail';

export const dynamic = 'force-dynamic';

export default async function ReviewDetailPage({params}: {params: Promise<{id: string}>}) {
  const user = await pageUser();
  const {id} = await params;
  const detail = await getReviewDetail(id);
  if (!detail) notFound();
  return <ReviewItemDetail detail={detail} actor={{id: user.id, role: user.role}} />;
}
