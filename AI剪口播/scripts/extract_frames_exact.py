#!/usr/bin/env python3
"""Extract exact zero-based CFR frame IDs from finalized media via keyframe seek."""
from pathlib import Path
from fractions import Fraction
import argparse,json,time
import av
p=argparse.ArgumentParser(description=__doc__);p.add_argument('video',type=Path);p.add_argument('--frames',required=True);p.add_argument('--output-dir',required=True,type=Path);a=p.parse_args();ids=sorted(set(int(x) for x in a.frames.split(',')));assert ids and min(ids)>=0
start=time.perf_counter();a.output_dir.mkdir(parents=True,exist_ok=True);c=av.open(str(a.video));v=c.streams.video[0];assert v.start_time==0 and v.average_rate==v.base_rate,'Requires finalized zero-start CFR video'
ticks=Fraction(1,v.average_rate)/v.time_base;assert ticks.denominator==1,'Requires integral frame ticks';ticks=int(ticks);rows=[]
for n in ids:
 assert n<v.frames,(n,v.frames)
 target=n*ticks;c.seek(target,stream=v,backward=True,any_frame=False);decoded=0;found=False
 for f in c.decode(v):
  decoded+=1
  if f.pts==target:
   out=a.output_dir/f'frame-{n:06d}.png';f.to_image().save(out);rows.append({'frame':n,'pts':target,'seconds':float(target*v.time_base),'path':str(out),'decoded_frames':decoded});found=True;break
  if f.pts>target:break
 assert found,f'Exact target PTS missing: frame={n} pts={target}'
c.close();report={'video':str(a.video.resolve()),'fps':str(v.average_rate),'time_base':str(v.time_base),'frames':rows,'seconds':time.perf_counter()-start};(a.output_dir/'frame-report.json').write_text(json.dumps(report,indent=2));print('EXACT_FRAME_EXTRACTION_PASS',len(rows))
