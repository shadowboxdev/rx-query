import {
	Observable,
	of,
	isObservable,
	defer,
	timer,
	fromEvent,
	EMPTY,
	interval,
	NEVER,
	asyncScheduler,
	scheduled,
} from 'rxjs';
import {
	map,
	startWith,
	catchError,
	switchMap,
	expand,
	debounce,
	withLatestFrom,
	distinctUntilChanged,
	finalize,
	filter,
	mergeAll,
	take,
	pairwise,
	concatMap,
	share,
} from 'rxjs/operators';
import { revalidate, cache } from './cache';
import { QueryOutput, QueryConfig, Revalidator } from './types';

export const DEFAULT_QUERY_CONFIG: Required<QueryConfig> = {
	retries: 3,
	retryDelay: (n) => (n + 1) * 1000,
	refetchOnWindowFocus: false,
	refetchInterval: undefined as any,
	staleTime: 0,
	cacheTime: 30_0000, // 5 minutes
};

export function query<
	QueryParam,
	QueryResult,
	Query extends (params: QueryParam) => Observable<QueryResult>
>(
	key: string,
	query: Query,
	config?: QueryConfig,
): Observable<QueryOutput<QueryResult>>;
export function query<
	QueryParam,
	QueryResult,
	Query extends (params: QueryParam) => Observable<QueryResult>
>(
	key: string,
	observableOrStaticParam: QueryParam | Observable<QueryParam>,
	query: Query,
	config?: QueryConfig,
): Observable<QueryOutput<QueryResult>>;
export function query<
	QueryParam,
	QueryResult,
	Query extends (params?: QueryParam) => Observable<QueryResult>
>(key: string, ...inputs: any[]): Observable<QueryOutput<QueryResult>> {
	const { query, queryParam, queryConfig } = parseInput<QueryParam, Query>(
		inputs,
	);
	const retryCondition = createRetryCondition(queryConfig);
	const retryDelay = createRetryDelay(queryConfig);

	const invokeQuery: QueryInvoker<QueryParam, QueryResult> = (
		loadingState: string,
		params?: QueryParam,
	): Observable<QueryOutput<QueryResult>> => {
		const invoke = (retries: number) => {
			return query(params).pipe(
				map(
					(data): QueryOutput<QueryResult> => {
						return {
							state: 'success',
							data,
							...(retries ? { retries } : {}),
						};
					},
				),
				catchError(
					(error): Observable<QueryOutput<QueryResult>> => {
						return of({
							state: 'error',
							error,
							retries,
						});
					},
				),
			);
		};

		const callResult$: Observable<QueryOutput<QueryResult>> = defer(() =>
			invoke(0).pipe(
				expand((result) => {
					if (
						result.state === 'error' &&
						retryCondition(result.retries || 0, result.error)
					) {
						return timer(retryDelay(result.retries || 0)).pipe(
							switchMap(() => invoke((result.retries || 0) + 1)),
							// retry internally
							// for consumers we're still loading
							startWith({
								...result,
								state: loadingState,
							} as QueryOutput<QueryResult>),
						);
					}

					return EMPTY;
				}),
				// prevents that there's multiple emits in the same tick
				// for when the status is swapped from error to loading (to retry)
				debounce((result) => (result.state === 'error' ? timer(0) : EMPTY)),
			),
		);

		return callResult$;
	};

	return defer(() => {
		const params$ = paramsTrigger<QueryParam, QueryResult>(
			queryConfig,
			queryParam,
			key,
			invokeQuery,
		);
		const focus$ = focusTrigger<QueryParam, QueryResult>(
			queryConfig,
			queryParam,
			key,
			invokeQuery,
		);
		const interval$ = intervalTrigger<QueryParam, QueryResult>(
			queryConfig,
			queryParam,
			key,
			invokeQuery,
		);

		const triggersSubscription = scheduled(
			[params$, focus$, interval$],
			asyncScheduler,
		)
			.pipe(mergeAll())
			.subscribe((c) => revalidate.next(c));

		return cache.pipe(
			withLatestFrom(params$),
			map(([c, k]) => c[k.key]),
			filter((v) => !!v),
			map((v) => v.result),
			distinctUntilChanged((a, b) => a === b),
			finalize(() => {
				params$.pipe(take(1)).subscribe((params) => {
					revalidate.next({
						key: params.key,
						query: invokeQuery,
						trigger: 'query-unsubscribe',
						params,
						config: queryConfig,
					});
				});

				triggersSubscription.unsubscribe();
			}),
			share(),
		);
	});
}

function createRetryDelay(queryConfig: Required<QueryConfig>) {
	return typeof queryConfig.retryDelay === 'number'
		? () => queryConfig.retryDelay as number
		: queryConfig.retryDelay || (() => 0);
}

function createRetryCondition(queryConfig: Required<QueryConfig>) {
	return typeof queryConfig.retries === 'number'
		? (n: number) => n < (queryConfig.retries || 0)
		: queryConfig.retries || (() => false);
}

function paramsTrigger<QueryParam, QueryResult>(
	queryConfig: Required<QueryConfig>,
	queryParam: Observable<QueryParam>,
	key: string,
	invokeQuery: QueryInvoker<QueryParam, QueryResult>,
): Observable<Revalidator<QueryParam, QueryResult>> {
	return queryParam.pipe(
		startWith(undefined),
		distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
		pairwise(),
		concatMap(([previous, params]) => {
			const revalidates = [];
			if (previous !== undefined) {
				const unsubscribe: Revalidator = {
					key: queryKeyAndParamsToCacheKey(key, previous),
					query: invokeQuery,
					trigger: 'query-unsubscribe',
					params: previous,
					config: queryConfig,
				};
				revalidates.push(unsubscribe);
			}

			const init: Revalidator = {
				key: queryKeyAndParamsToCacheKey(key, params),
				query: invokeQuery,
				trigger: 'query-subscribe',
				params,
				config: queryConfig,
			};
			revalidates.push(init);
			return revalidates;
		}),
	);
}

function intervalTrigger<QueryParam, QueryResult>(
	queryConfig: Required<QueryConfig>,
	queryParam: Observable<QueryParam>,
	key: string,
	invokeQuery: QueryInvoker<QueryParam, QueryResult>,
): Observable<Revalidator<QueryParam, QueryResult>> {
	return queryConfig.refetchInterval !== undefined &&
		queryConfig.refetchInterval !== null
		? (isObservable(queryConfig.refetchInterval)
				? queryConfig.refetchInterval
				: interval(queryConfig.refetchInterval)
		  ).pipe(
				withLatestFrom(queryParam),
				map(([_, params]) => {
					const interval: Revalidator = {
						key: queryKeyAndParamsToCacheKey(key, params),
						query: invokeQuery,
						trigger: 'interval',
						params,
						config: queryConfig,
					};
					return interval;
				}),
		  )
		: NEVER;
}

function focusTrigger<QueryParam, QueryResult>(
	queryConfig: Required<QueryConfig>,
	queryParam: Observable<QueryParam>,
	key: string,
	invokeQuery: QueryInvoker<QueryParam, QueryResult>,
): Observable<Revalidator<QueryParam, QueryResult>> {
	return queryConfig.refetchOnWindowFocus
		? fromEvent(window, 'focus').pipe(
				withLatestFrom(queryParam),
				map(([_, params]) => {
					const focused: Revalidator = {
						key: queryKeyAndParamsToCacheKey(key, params),
						query: invokeQuery,
						trigger: 'focus',
						params,
						config: queryConfig,
					};
					return focused;
				}),
		  )
		: NEVER;
}

function parseInput<QueryParam, Query>(inputs: any[]) {
	const [firstInput, secondInput, thirdInput] = inputs;

	const hasParamInput = typeof firstInput !== 'function';

	const queryParam = (hasParamInput
		? isObservable(firstInput)
			? firstInput
			: of(firstInput)
		: of(null)) as Observable<QueryParam>;

	const query = (typeof firstInput === 'function'
		? firstInput
		: secondInput) as Query;

	const inputConfig = (hasParamInput ? thirdInput : secondInput) as
		| QueryConfig
		| undefined;

	const queryConfig = {
		...DEFAULT_QUERY_CONFIG,
		...inputConfig,
	};

	return {
		query,
		queryParam,
		queryConfig,
	};
}

function queryKeyAndParamsToCacheKey(key: string, params: unknown) {
	if (params !== undefined && params !== null) {
		return (
			key +
			'-' +
			(['string', 'number'].includes(typeof params)
				? params
				: JSON.stringify(params))
		);
	}

	return key;
}

type QueryInvoker<QueryParam, QueryResult> = (
	state: string,
	params?: QueryParam,
) => Observable<QueryOutput<QueryResult>>;