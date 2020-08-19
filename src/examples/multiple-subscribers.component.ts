import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs/operators';

import { query } from '../../rx-query';

@Component({
	selector: 'example-multiple-subscribers',
	template: `
		<button
			class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
			(click)="addConsumer()"
		>
			Add consumer
		</button>
		<div class="flex">
			<ng-container *ngFor="let consumer$ of consumers; let index = index">
				<div
					class="flex-auto rounded shadow-lg px-4 py-2 m-2 cursor-pointer"
					*ngIf="consumer$ | async as consumer"
					(click)="removeConsumer(index)"
				>
					<div [ngSwitch]="consumer.state">
						<div *ngSwitchDefault class="md:flex bg-white rounded-lg p-6">
							<div class="text-center md:text-left">
								<h2 class="text-lg text-blue-500">
									{{ consumer.data.time }}
								</h2>
							</div>
						</div>
						<div *ngSwitchCase="'loading'">
							Loading ...
						</div>
						<div *ngSwitchCase="'error'">
							Something went wrong ...
						</div>
					</div>
				</div>
			</ng-container>
		</div>
		<rx-query-devtool></rx-query-devtool>
	`,
	styles: [
		`
			.flex {
				flex-wrap: wrap;
			}
		`,
	],
})
export class MultipleSubscribersComponent {
	consumers: any[] = [];

	constructor(private http: HttpClient) {}

	addConsumer() {
		const q: any = query(
			'example-multiple-subscribers',
			() =>
				this.http.get('/now').pipe(
					map((utc: any) => {
						return {
							time: new Intl.DateTimeFormat('default', {
								year: 'numeric',
								month: 'numeric',
								day: 'numeric',
								hour: 'numeric',
								minute: 'numeric',
								second: 'numeric',
								timeZoneName: 'short',
							}).format(utc.now),
						};
					}),
				),
			{
				cacheTime: 5000,
			},
		);
		this.consumers.push(q);
	}

	removeConsumer(index: number) {
		this.consumers.splice(index, 1);
	}
}
